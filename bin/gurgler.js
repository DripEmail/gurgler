#! /usr/bin/env node
const fs = require('fs');
const AWS = require('aws-sdk');
const inquirer = require('inquirer');
const program = require('commander');
const path = require('path');
const _ = require('lodash');
const crypto = require('crypto');
const NodeGit = require('nodegit');
const { IncomingWebhook } = require('@slack/webhook');
const glob = require("glob");


/**
 * *******************
 * Get the config values and verify them and do a little setup work.
 * *******************
 */

// TODO There's got to be a better way to get the path for this.
const gurglerPath = path.join(process.env.PWD, 'gurgler.json')
const packageValues = require(path.join(process.env.PWD, 'package.json'));
const packageName = packageValues['name'];
const gurglerConfig = packageValues["gurgler"];
const environments = gurglerConfig["environments"];
const bucketNames = gurglerConfig["bucketNames"];
const bucketPath = gurglerConfig["bucketPath"];
const bucketRegion = gurglerConfig["bucketRegion"];
const globs = gurglerConfig["globs"];
const slackWebHookUrl = gurglerConfig["slackWebHookUrl"];
const slackUsername = gurglerConfig["slackUsername"];
const slackIconEmoji = gurglerConfig["slackIconEmoji"];
const githubRepoUrl = gurglerConfig["githubRepoUrl"];

let localFilePaths = gurglerConfig["localFilePaths"];
let useSlackWebHook = false;

if (_.isEmpty(packageName)) {
  console.error("The package name is not set.");
  process.exit(1);
}

if (_.isEmpty(bucketNames)) {
  console.error("The config value bucketNames is not set.");
  process.exit(1);
}

if (_.isEmpty(bucketPath)) {
  console.error("The config value bucketPath is not set.");
  process.exit(1);
}

if (_.isEmpty(bucketRegion)) {
  console.error("The config value bucketRegion is not set.");
  process.exit(1);
}

if (_.isEmpty(globs) && _.isEmpty(localFilePaths)) {
  console.log("The config values globs and localFilePaths are both empty. One or both must be present with at least one value between the two.")
  process.exit(1);
}

if (!_.isEmpty(globs)) {

  if (!_.isArray(globs)) {
    console.log("The config value globs is not an array");
    process.exit(1);
  }

  globs.forEach(globb => {

    if (_.isEmpty(globb.pattern)) {
      console.log("At least one glob pattern is not set.");
      process.exit(1);
    }

    if (!_.isString(globb.pattern)) {
      console.log("At least one glob pattern is not a string.");
      process.exit(1);
    }

    if (_.has(globb, "ignore")) {

      if (!_.isArray(globb.ignore)) {
        console.log("At least one glob ignore is not an array.");
        process.exit(1);
      }

      globb.ignore.forEach(ignore => {

        if (!_.isString(ignore)) {
          console.log("At least one glob ignore array value is not a string.");
          process.exit(1);
        }
      })
    }
  });
}

if (!_.isEmpty(localFilePaths)) {
  if (!_.isArray(localFilePaths)) {

  }
  localFilePaths.forEach(filepath => {
    if (!_.isString(filepath)) {
      console.log("At least one localFilePath value is not a string.");
      process.exit(1);
    }
    
    if (_.isEmpty(filepath)) {
      console.log("At least one localFilePath value is an empty string.");
      process.exit(1);
    }
  });
}

// Omit all slack-related keys from the package.json to disable slack.
if (_.has(gurglerConfig, "slackWebHookUrl") || _.has(gurglerConfig, "slackUsername") || _.has(gurglerConfig, "slackIconEmoji")) {

  if (_.isEmpty(slackWebHookUrl)) {
    console.error("The config value slackWebHookUrl is not set.");
    process.exit(1);
  }
  
  if (_.isEmpty(slackUsername)) {
    console.error("The config value slackUsername is not set.");
    process.exit(1);
  }
  
  if (_.isEmpty(slackIconEmoji)) {
    console.error("The config value slackIconEmoji is not set.");
    process.exit(1);
  }

  if (_.isEmpty(githubRepoUrl)) {
    console.error("The config value githubRepoUrl is not set.");
    process.exit(1);
  }

  useSlackWebHook = true;
}

AWS.config.update({
  region: bucketRegion
});

/**
 * *****************
 * Utility functions
 * *****************
 */

const shortHash = hash => hash.substring(0, 7);

const getContentType = (ext) => {
  // This default content type is that to which S3 defaults.
  let contentType = "application/octet-stream";
  // TODO: Add more content types
  if  (ext === ".css") {
    contentType = "text/css";
  } else if (ext === ".json") {
    contentType = "application/json"
  } else if (ext === ".html") {
    contentType = "text/html"
  } else if (ext ===  ".js") {
    contentType = "application/javascript"
  }
  return contentType;
}

/**
 * Get the currently release values for all the environments.
 *
 * @param environments
 * @returns {Promise<[{object}]>}
 */

const requestCurrentlyReleasedVersions = (environments) => {

  const ssmKeys = environments.map(env => env.ssmKey);

  const ssm = new AWS.SSM({
    apiVersion: '2014-11-06'
  });

  const params = {
    Names: ssmKeys
  };

  return new Promise((resolve, reject) => {
    ssm.getParameters(params, (err, data) => {
      if (err) {
        return reject(err);
      }

      const environmentsWithReleaseData = environments.map(env => {
        const value = _.find(data.Parameters, v => env.ssmKey === v.Name);

        env.releasedChecksum = _.get(value, "Value", "Unreleased!");
        env.releaseChecksumShort = env.releasedChecksum === "Unreleased!" ? "Unreleased!" : shortHash(env.releasedChecksum)
        env.releaseDateStr = _.get(value, "LastModifiedDate");

        return env;
      });

      return resolve(environmentsWithReleaseData);
    });
  });
};


/**
 * Send the asset up to S3. This is the deprecated version which deploys all files under the bucketPath
 * prefix with their own checksum in the filename (e.g. some_file.asdfasdf.js).
 *
 * @param {array} bucketNames
 * @param {string} bucketPath
 * @param {string} localFilePath
 * @param {string} gitBranch
 * @param {string} gitCommitSha
 */

const readFileAndDeploy = (bucketNames, bucketPath, localFilePath, gitBranch, gitCommitSha) => {
  const hash = crypto.createHash('sha256');
  const { name: fileName } = path.parse(localFilePath);
  const gitSha = `${gitCommitSha}|${gitBranch}`;

  // TODO upload map file if it exists.

  // TODO send source maps to Honeybadger (but maybe just the ones we deploy)

  fs.readFile(localFilePath, (err, data) => {
    if (err) {
      throw err;
    }

    hash.update(data);
    const checksum = hash.digest('hex');
    const remoteFilePath = path.join(bucketPath, `${fileName}.${checksum}.js`);

    _.forEach(bucketNames, (bucketName) => {
      const s3 = new AWS.S3({
        apiVersion: '2006-03-01',
        params: { Bucket: bucketName }
      });

      s3.upload({
        Key: remoteFilePath,
        Body: data,
        ACL: 'public-read',
        Metadata: { 'git-sha': gitSha },
      },(err) => {
        if (err) {
          throw err;
        }
        console.log(`Successfully deployed ${localFilePath} to S3 bucket ${bucketName} ${remoteFilePath}`);
      });
    });
  });
};

/**
 * Send the file to S3. All files except gurgler.json are considered assets and will be prefixed with
 * the appropriate value. If there are more than 1 hierarchies to the prefix, gurgler.json will maintain
 * all prefixes save the last, to which it will be appended. For example, a prefix of assets/asdsf will
 * result in all assets being stored within that prefix but gurgler.json will become assets/asdf.gurgler.json.
 *
 * @param {array} bucketNames
 * @param {string} prefix
 * @param {string} localFilePath
 * @param {string} gitInfo
 */

const readFileAndDeployV2 = (bucketNames, prefix, localFilePath, gitInfo) => {
  
  // TODO upload map file if it exists.

  // TODO send source maps to Honeybadger (but maybe just the ones we deploy)

  fs.readFile(localFilePath, (err, data) => {
    if (err) {
      throw err;
    }
    
    const { base, ext } = path.parse(localFilePath);
    const contentType = getContentType(ext);

    let remoteFilePath;
    if (base === "gurgler.json") {
      // prefix.gurgler.json is a sibling to the prefix under which all the assets are keyed.
      remoteFilePath = `${prefix}.${base}`
    } else {
      remoteFilePath = path.join(prefix, base);
    }

    _.forEach(bucketNames, (bucketName) => {
      const s3 = new AWS.S3({
        apiVersion: '2006-03-01',
        params: { Bucket: bucketName }
      });

      s3.upload({
        Key: remoteFilePath,
        Body: data,
        ACL: 'public-read',
        Metadata: { 'git-info': gitInfo },
        ContentType: contentType,
      },(err) => {
        if (err) {
          throw err;
        }
        console.log(`Successfully deployed ${localFilePath} to S3 bucket ${bucketName} ${remoteFilePath}`);
      });
    });
  });
};

/**
 * Get all the assets in a bucket with a particular prefix (which essentially acts like a file path).
 * @param bucketName
 * @param prefix
 * @returns {Promise<[{object}]>}
 */

const getDeployedVersionList = (bucketName, prefix) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    let allVersions = [];

    const listAllVersions = (token) => {
      const opts = {
        Bucket: bucketName,
        // We want all gurgler.json keys, not any of the actual asset keys.
        Delimiter: "/",
        Prefix: prefix + "/",
      };

      if (token) {
        opts.ContinuationToken = token;
      }
      
      s3.listObjectsV2(opts, (err, data) => {
        if (err) {
          reject()
        }

        allVersions = allVersions.concat(data.Contents);

        if (data.IsTruncated){
          listAllVersions(data.NextContinuationToken);
        }
        else {
          resolve(allVersions.map(version => {
            return {
              filepath: version.Key,
              lastModified: version.LastModified,
              bucket: bucketName,
            }
          }));
        }
      });
    };
    listAllVersions();
  });
};

/**
 * Sort the list of versions so the latest are first then return a slice of the first so many.
 *
 * @param versions
 * @param size
 * @returns {[{object}]}
 */

const formatAndLimitDeployedVersions = (versions, size) => {
  const returnedVersions = [];
  
  _.reverse(
    _.sortBy(
      versions,
      ['lastModified']
    )
  )
    .slice(0, size).forEach(version => {

    const { name: filename } = path.parse(version.filepath);

    if (filename !== '' && filename !== undefined) {
      version.checksum = filename.split('-')[0];
      version.checksumDigest = version.checksum.substr(0, 7);
      returnedVersions.push(version);
    }
  });

  return returnedVersions;
};

/**
 * Take a version object and add git data to it.
 *
 * @param version
 * @returns {Promise<object>}
 */

const addGitSha = (version) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    s3.headObject({
      Bucket: version.bucket,
      Key: version.filepath
    }, (err, data) => {
      if (err) {
        return reject(err);
      }

      const metaData = data.Metadata['git-info'];
      if (metaData !== '' && metaData !== undefined) {
        const parsedMetaData = metaData.split('|');
        version.gitSha = parsedMetaData[0];
        version.gitShaDigest = parsedMetaData[0].substr(0, 7);
        version.gitBranch = parsedMetaData[1];
      }
      return resolve(version);
    });
  });
};

const addGitInfo = (version) => {
  const gitSha = version.gitSha;

  return NodeGit.Repository.open('.')
    .then(repo => {
      return repo.getCommit(gitSha);
    })
    .catch(err => {
      if (!(err.message.match(/unable to parse OID/)
        || err.message.match(/no match for id/))) {
        console.log(`Warning, could not get commit: git[${gitSha}],`, err.message.replace(/(\r\n|\n|\r)/gm, ''));
      }
      return undefined;
    })
    .then(commit => {
      if (commit === undefined) {
        version.displayName = version.lastModified.toLocaleDateString(
          'en-US',
          { month: '2-digit', day: '2-digit', year: 'numeric' }
          );
        const checksumShort = shortHash(version.checksum);
        version.displayName += (` | ${packageName}[${checksumShort}]`);
        return version;
      }

      const author = commit.author();
      const commitDateStr = commit.date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const checksumShort = shortHash(version.checksum);
      const gitShaShort = shortHash(gitSha);
      const gitBranch = _.isEmpty(version.gitBranch) ? "" : _.truncate(version.gitBranch, {length: 15});
      const gitMessage = _.truncate(commit.message(), {length: 30}).replace(/(\r\n|\n|\r)/gm, '');
      version.displayName = `${commitDateStr} | ${packageName}[${checksumShort}] | ${author.name()} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;
      return version;
    });
};

/**
 * Update the value for the chosen environment in SSM.
 *
 * @param {object} environment
 * @param {object} version
 */

const release = (environment, version) => {
  const ssm = new AWS.SSM({
    apiVersion: '2014-11-06'
  });

  const ssmKey = environment.ssmKey;

  const ssmParams = {
    Name: ssmKey,
    Value: version.checksum,
    Type: 'String',
    Overwrite: true
  };
  ssm.putParameter(ssmParams, (err) => {
    if (err) {
      throw err;
    }
    sendReleaseMessage(environment, version);
  });
};

/**
 * Sends a message when the Slack when a release happens.
 *
 * @param {object} environment The users chosen environment.
 * @param {object} version The users chosen version.
 */

const sendReleaseMessage = (environment, version) => {
  const userDoingDeploy = process.env.USER;
  const simpleMessage = `${userDoingDeploy} successfully released the version ${packageName}[${version.gitSha}] to ${environment.key}`;

  if (useSlackWebHook) {
    const slackMessage = [
      `*${userDoingDeploy}* successfully released a new ${packageName} version to *${environment.key}*`,
      `_${version.displayName}_`,
      `<${githubRepoUrl}/commit/${version.gitSha}|View commit on GitHub>`,
    ].join("\n");
  
    const slackChannel = environment.slackChannel;
  
    if (!_.isEmpty(slackWebHookUrl) && !_.isEmpty(slackChannel)) {
      const webhook = new IncomingWebhook(slackWebHookUrl);
  
      (async () => {
        await webhook.send({
          username: slackUsername,
          text: slackMessage,
          icon_emoji: slackIconEmoji,
          channel: slackChannel
        })
      })().catch(err => console.error(err));
    }
  }
  
  console.log(simpleMessage);
};

/**
 * *****************
 * The "main" part of the program.
 * *****************
 */

program
  .command('configure <gitCommitSha> <gitBranch>')
  .description('configures a gurgler.json in the project root to be referenced in the build and deploy process')
  .action((commit, branch) => {
    const hash = crypto.createHash('sha256');
    const raw = `${commit}|${branch}`;
    
    hash.update(raw);
    const hashed = hash.digest('hex');
    const prefix = bucketPath + "/" + hashed
    
    const data = JSON.stringify({
      commit,
      branch,
      raw,
      hash: hashed,
      prefix,
    }, null, 2);

    fs.writeFile(gurglerPath, data, err => {
      if (err) {
        throw err
      }
      console.log(`gurgler successfully configured; the current build info can be found at ${gurglerPath}\n`);
    })
  });

program
  .command('deploy')
  .description('sends a new version (at a particular commit on a particular branch) to the S3 bucket')
  .action(() => {
    fs.readFile(gurglerPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          console.log("Either gurgler.json has not been built or it has been removed. Run 'gurgler configure <git commit sha> <git branch>' and try again.");
        }
        throw err;
      }

      if (!localFilePaths) {
        localFilePaths = []
      }
      localFilePaths.push(gurglerPath);
      
      globs.forEach(globb => {
        localFilePaths = localFilePaths.concat(glob.sync(globb.pattern, {
          ignore: globb.ignore
        }))
      })

      const { commit, branch, raw, prefix } = JSON.parse(data)

      localFilePaths.forEach(localFilePath => {

        // TODO: This is the old deployment method and should be removed when safe.
        readFileAndDeploy(bucketNames, bucketPath, localFilePath, commit, branch);

        readFileAndDeployV2(bucketNames, prefix, localFilePath, raw);
      });
    });
  });

const determineEnvironment = (cmdObj, environments) => {
  if (_.isEmpty(cmdObj.environment)) {
    return inquirer.prompt([ {
      type: 'list',
      name: 'environment',
      message: 'Which environment will receive this release?',
      choices: environments.map(env => {
        const label = _.padEnd(env.label, 12);
        return {
          name: `${label} ${env.releaseChecksumShort}`,
          value: env
        }
      })
    }]);
  }
  else {
    return new Promise(((resolve) => {
      const environment = _.find(environments, e => e.key === cmdObj.environment);
      if (!environment) {
        const keys = environments.map(e => e.key);
        const keysStr = _.join(keys, ", ");
        console.error(`"${cmdObj.environment}" does not appear to be a valid environment. The choices are: ${keysStr}`);
        process.exit(1);
      }
      resolve({environment: environment});
    }))
  }
};

const determineGurglerToRelease = (cmdObj, environment) => {
  const bucketName = _.get(bucketNames, environment.serverEnvironment);
  if (!bucketName) {
    console.error(`\nThe server environment "${environment.serverEnvironment}" does not exist, the environment must match a bucketNames key in package.json\n`)
    process.exit(1);
  }

  return getDeployedVersionList(bucketName, bucketPath)
    .then(versions => {
      return formatAndLimitDeployedVersions(versions, 20); // Only show last 20 versions
    })
    .then(versions => {
      return Promise.all(versions.map(version => addGitSha(version)));
    })
    .then(versions => {
      return Promise.all(versions.map(version => addGitInfo(version)));
    })
    .then(versions => {
      if( _.isEmpty(cmdObj.commit)) {
        return inquirer.prompt([ {
            type: 'list',
            name: 'version',
            message: 'Which deployed version would you like to release?',
            choices: versions.map(version => {
                return {name: version.displayName, value: version}
              }
            )
        }])
      } else {
        return new Promise(((resolve) => {
          if (cmdObj.commit.length < 7) {
            console.error(`The checksum "${cmdObj.commit}" is not long enough, it should be at least 7 characters.`);
            process.exit(1);
          }

          const version = _.find(versions, version => {
            return _.startsWith(version.gitSha, cmdObj.commit)
          });

          // TODO If we do not find it in this list of assets, check older assets too.

          if (!version) {
            console.error(`"${cmdObj.commit}" does not appear to be a valid checksum.`);
            process.exit(1);
          }

          resolve({version: version});
        }));
      }
    })
};

const confirmRelease = (environment, version) => {
  return inquirer.prompt([{
    type: 'confirm',
    name: 'confirmation',
    message: `Do you want to release ${packageName} git[${version.gitShaDigest}] checksum[${version.checksumDigest}] to ${environment.key}?`,
    default: false
  }]).then(answers => {
    if (
      answers.confirmation && 
      environment.masterOnly && 
      version.gitBranch !== 'master'
    ) {
      return inquirer.prompt([{
        type: 'confirm',
        name: 'confirmation',
        message: `Warning: You are attempting to release a non-master branch[${version.gitBranch}] to a master-only environment[${environment.serverEnvironment}]. Do you wish to proceed?`,
      }])
    }
    return answers;
  })
};

program
  .command('release')
  .description('takes a previously deployed version and turns it on for a particular environment')
  .option("-e, --environment <environment>", "environment to deploy to")
  .option("-c, --commit <gitSha>", "the git sha (commit) of the version to deploy")
  .action((cmdObj) => {

    let environment;
    let version;
    requestCurrentlyReleasedVersions(environments)
      .then(environments => {
        return determineEnvironment(cmdObj, environments)
      })
      .then(answers => {
        environment = answers.environment;
        return determineGurglerToRelease(cmdObj, environment)
      })
      .then(answers => {
        version = answers.version;
        return confirmRelease(environment, version);
      })
      .then(answers => {
        if (answers.confirmation) {
          release(environment, version);
        } else {
          console.log("Cancelling release...");
        }
      })
      .catch(err => console.error(err));
  });

program.parse(process.argv);
