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


/**
 * *******************
 * Get the config values and verify them and do a little setup work.
 * *******************
 */

// TODO There's got to be a better way to get the path for this.
const packageValues = require(path.join(process.env.PWD, 'package.json'));
const packageName = packageValues['name'];
const gurglerConfig = packageValues["gurgler"];
const environments = gurglerConfig["environments"];
const bucketNames = gurglerConfig["bucketNames"];
const bucketPath = gurglerConfig["bucketPath"];
const bucketRegion = gurglerConfig["bucketRegion"];
const localFilePaths = gurglerConfig["localFilePaths"];
const slackWebHookUrl = gurglerConfig["slackWebHookUrl"];
const slackUsername = gurglerConfig["slackUsername"];
const slackIconEmoji = gurglerConfig["slackIconEmoji"];
const githubRepoUrl = gurglerConfig["githubRepoUrl"];

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

if (_.isEmpty(localFilePaths)) {
  console.error("The config value localFilePaths is not set.");
  process.exit(1);
}

if (!_.isArray(localFilePaths)) {
  console.error("The config value localFilePaths is not an array.");
  process.exit(1);
}

localFilePaths.forEach(path => {
  if (!_.isString(path)) {
    console.error("One of the paths in localFilePaths is not a string.");
    process.exit(1);
  }

  if (_.isEmpty(path)) {
    console.error("One of the paths in localFilePaths is empty.");
    process.exit(1);
  }
});

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
 * Send the asset up to S3.
 *
 * @param {array} bucketNames
 * @param {string} bucketPath
 * @param {string} localFilePath
 * @param {string} gitBranch
 * @param {string} gitCommitSha
 */

const readFileAndDeploy = (bucketNames, bucketPath, localFilePath, gitInfo) => {
  
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
      // We want gurgler.json to live in the same hierarchical tier as each unique prefix (as a sibling)
      // to the checksum to which the gurgler.json pertains. The release command will thus avoid retrieving
      // all objects, instead retrieving a single gurgler.json for each branch/commit.
      remoteFilePath = `${bucketPath}-${base}`
    } else {
      remoteFilePath = path.join(bucketPath, base);
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
        Metadata: { 'git-sha': gitInfo },
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

const getGurglers = (bucketName, prefix) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    let allKeys = [];

    const listAllKeys = (token) => {
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

        allKeys = allKeys.concat(data.Contents);

        if (data.IsTruncated){
          listAllKeys(data.NextContinuationToken);
        }
        else {
          resolve(allKeys.map(gurgler => {
            return {
              filepath: gurgler.Key,
              lastModified: gurgler.LastModified,
              bucket: bucketName,
            }
          }));
        }
      });
    };
    listAllKeys();
  });
};

/**
 * Sort the list of assets so the latest are first then return a slice of the first so many.
 *
 * @param assets
 * @param size
 * @returns {[{object}]}
 */

const formatAndLimitGurglers = (gurglers, size) => {
  const returnedGurglers = [];

  _.reverse(
    _.sortBy(
      gurglers,
      ['lastModified']
    )
  )
    .slice(0, size).forEach(gurgler => {

    const { name: filename } = path.parse(gurgler.filepath);

    if (filename !== '' && filename !== undefined) {
      gurgler.checksum = filename.split('-')[0];
      gurgler.checksumDigest = gurgler.checksum.substr(0, 7);
      returnedGurglers.push(gurgler);
    }
  });

  return returnedGurglers;
};

/**
 * Take an asset object and add git data to it.
 *
 * @param asset
 * @returns {Promise<object>}
 */

const addGitSha = (asset) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    s3.headObject({
      Bucket: asset.bucket,
      Key: asset.filepath
    }, (err, data) => {
      if (err) {
        return reject(err);
      }

      const metaData = data.Metadata['git-sha'];
      if (metaData !== '' && metaData !== undefined) {
        const parsedMetaData = metaData.split('|');
        asset.gitSha = parsedMetaData[0];
        asset.gitShaDigest = parsedMetaData[0].substr(0, 7);
        asset.gitBranch = parsedMetaData[1];
      }
      return resolve(asset);
    });
  });
};

const addGitInfo = (asset) => {
  const gitSha = asset.gitSha;

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
        asset.displayName = asset.lastModified.toLocaleDateString(
          'en-US',
          { month: '2-digit', day: '2-digit', year: 'numeric' }
          );
        const checksumShort = shortHash(asset.checksum);
        asset.displayName += (` | ${packageName}[${checksumShort}]`);
        return asset;
      }

      const author = commit.author();
      const commitDateStr = commit.date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const checksumShort = shortHash(asset.checksum);
      const gitShaShort = shortHash(gitSha);
      const gitBranch = _.isEmpty(asset.gitBranch) ? "" : _.truncate(asset.gitBranch, {length: 15});
      const gitMessage = _.truncate(commit.message(), {length: 30}).replace(/(\r\n|\n|\r)/gm, '');
      asset.displayName = `${commitDateStr} | ${packageName}[${checksumShort}] | ${author.name()} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;
      return asset;
    });
};

/**
 * Update the value for the chosen environment in SSM.
 *
 * @param {object} environment
 * @param {object} asset
 */

const release = (environment, asset) => {
  const ssm = new AWS.SSM({
    apiVersion: '2014-11-06'
  });

  const ssmKey = environment.ssmKey;

  const ssmParams = {
    Name: ssmKey,
    Value: asset.checksum,
    Type: 'String',
    Overwrite: true
  };
  ssm.putParameter(ssmParams, (err) => {
    if (err) {
      throw err;
    }
    sendReleaseMessage(environment, asset);
  });
};

/**
 * Sends a message when the Slack when a release happens.
 *
 * @param {object} environment The users chosen environment.
 * @param {object} asset The users chosen asset.
 */

const sendReleaseMessage = (environment, asset) => {
  const userDoingDeploy = process.env.USER;
  const simpleMessage = `${userDoingDeploy} successfully released the asset ${packageName}[${asset.gitSha}] to ${environment.key}`;

  const slackMessage = [
    `*${userDoingDeploy}* successfully released a new ${packageName} asset to *${environment.key}*`,
    `_${asset.displayName}_`,
    `<${githubRepoUrl}/commit/${asset.gitSha}|View commit on GitHub>`,
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

  console.log(simpleMessage);
};

/**
 * *****************
 * The "main" part of the program.
 * *****************
 */

program
  .command('configure <gitCommitSha> <gitBranch>')
  .description('configures a gurgler.json in the root of the project to be referenced by the build and deployment pipeline')
  .action((gitCommitSha, gitBranch) => {
    const hash = crypto.createHash('sha256');
    const raw = `${gitCommitSha}|${gitBranch}`;
  
    hash.update(raw);
    const sha = hash.digest('hex');
    const prefix = bucketPath + "/" + sha

    const data = JSON.stringify({
      raw,
      sha,
      prefix,
    }, null, 2);

    const filepath = "gurgler.json"

    fs.writeFile(filepath, data, err => {
      if (err) {
        throw err
      }
      console.log(`gurgler successfully configured; see ${filepath}\n`);
    })
  });

program
  .command('deploy')
  .description('sends a new asset (at a particular commit on a particular branch) to the S3 bucket')
  .action(() => {
    const gurglerPath = "gurgler.json";
    fs.readFile(gurglerPath, (err, data) => {
      if (err) {
        throw err;
      }
      const { raw: gitInfo, prefix } = JSON.parse(data)
      localFilePaths.push(gurglerPath);
      localFilePaths.forEach(localFilePath => {
        readFileAndDeploy( bucketNames, prefix, localFilePath, gitInfo);
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
    console.error(`The server environment "${environment.serverEnvironment}" does not exist, the environment must match a bucketName key`)
    process.exit(1);
  }

  return getGurglers(bucketName, bucketPath)
    .then(gurglers => {
      return formatAndLimitGurglers(gurglers, 20); // Only show last 20 gurglers
    })
    .then(gurglers => {
      return Promise.all(gurglers.map(gurgler => addGitSha(gurgler)));
    })
    .then(gurglers => {
      return Promise.all(gurglers.map(gurgler => addGitInfo(gurgler)));
    })
    .then(gurglers => {
      if( _.isEmpty(cmdObj.commit)) {
        return inquirer.prompt([ {
            type: 'list',
            name: 'gurgler',
            message: 'Which deployed version would you like to release?',
            choices: gurglers.map(gurgler => {
                return {name: gurgler.displayName, value: gurgler}
              }
            )
        }])
      }
      else {
        return new Promise(((resolve) => {
          if (cmdObj.commit.length < 7) {
            console.error(`The checksum "${cmdObj.commit}" is not long enough, it should be at least 7 characters.`);
            process.exit(1);
          }

          const gurgler = _.find(gurglers, gurgler => {
            return _.startsWith(gurgler.gitSha, cmdObj.commit)
          });

          // TODO If we do not find it in this list of assets, check older assets too.

          if (!gurgler) {
            console.error(`"${cmdObj.commit}" does not appear to be a valid checksum.`);
            process.exit(1);
          }

          resolve({gurgler: gurgler});
        }));
      }
    })
};

const confirmRelease = (environment, gurgler) => {
  return inquirer.prompt([{
    type: 'confirm',
    name: 'confirmation',
    message: `Do you want to release ${packageName} git[${gurgler.gitShaDigest}] checksum[${gurgler.checksumDigest}] to ${environment.key}?`,
    default: false
  }]);
};

program
  .command('release')
  .description('takes a previously deployed asset a turns it on for a particular environment')
  .option("-e, --environment <environment>", "environment to deploy to")
  .option("-c, --commit <gitSha>", "the git sha (commit) of the asset to deploy")
  .action((cmdObj) => {

    let environment;
    let gurgler;
    requestCurrentlyReleasedVersions(environments)
      .then(environments => {
        return determineEnvironment(cmdObj, environments)
      })
      .then(answers => {
        environment = answers.environment;
        return determineGurglerToRelease(cmdObj, environment)
      })
      .then(answers => {
        gurgler = answers.gurgler;
        return confirmRelease(environment, gurgler);
      })
      .then(answers => {
        if (answers.confirmation) {
          release(environment, gurgler);
        } else {
          console.log("Cancelling release...");
        }
      })
      .catch(err => console.error(err));
  });

program.parse(process.argv);
