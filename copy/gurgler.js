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

const v1 = require("./v1");
const v2 = require("./v2");

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
  .action((commit, branch) => v2.configureCmd(gurglerPath, bucketPath, commit, branch));

program
  .command('deploy')
  .description('sends a new version (at a particular commit on a particular branch) to the S3 bucket')
  .action(() => {
    v1.deployCmd(gurglerPath, globs, localFilePaths);
    v2.deployCmd(gurglerPath, globs, localFilePaths);
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

const determineVersionToRelease = (cmdObj, environment) => {
  const bucketName = _.get(bucketNames, environment.serverEnvironment);
  if (!bucketName) {
    console.error(`The server environment ${environment.serverEnvironment} does not exist.`)
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
        return determineVersionToRelease(cmdObj, environment)
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