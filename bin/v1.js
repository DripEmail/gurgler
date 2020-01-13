const fs = require('fs');
const AWS = require('aws-sdk');
const inquirer = require('inquirer');
const path = require('path');
const _ = require('lodash');
const crypto = require('crypto');
const NodeGit = require('nodegit');
const { IncomingWebhook } = require('@slack/webhook');
const utils = require("./utils");

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
        env.releaseChecksumShort = env.releasedChecksum === "Unreleased!" ? "Unreleased!" : utils.shortHash(env.releasedChecksum)
        env.releaseDateStr = _.get(value, "LastModifiedDate");

        return env;
      });

      return resolve(environmentsWithReleaseData);
    });
  });
};

const determineEnvironment = (cmdObj, environments) => {
  if (_.isEmpty(cmdObj.environment)) {
    _.remove(environments, env => {
      return (_.has(env, "v2") && env.v2)
    });
    if (environments.length === 0) {
      console.log("> There are no configured v1 environments.\n");
      process.exit(0);
    }
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

/**
 * Get all the assets in a bucket with a particular prefix (which essentially acts like a file path).
 * @param bucketName
 * @param prefix
 * @returns {Promise<[{object}]>}
 */

const getAssets = (bucketName, bucketPath) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    let allAssets = [];

    const listAllAssets = (token) => {
      const opts = {
        Bucket: bucketName,
        Delimiter: "/",
        Prefix: bucketPath + "/"
      };

      if (token) {
        opts.ContinuationToken = token;
      }

      s3.listObjectsV2(opts, (err, data) => {
        if (err) {
          reject()
        }

        const concatenated = allAssets.concat(data.Contents);

        // Ignore all v2 assets and gurgler.json manifests.
        allAssets = _.filter(concatenated, asset => {
          const {base, ext} = path.parse(asset.Key);
          return (ext === ".js" && base.split(".")[0] !== "gurgler")
        });

        if (data.IsTruncated){
          listAllAssets(data.NextContinuationToken);
        }
        else {
          resolve(allAssets.map(asset => {
            return {
              filePath: asset.Key,
              lastModified: asset.LastModified,
              bucket: bucketName
            };
          }));
        }
      });
    };
    listAllAssets();
  });
};

/**
 * Sort the list of assets so the latest are first then return a slice of the first so many.
 *
 * @param assets
 * @param size
 * @returns {[{object}]}
 */

const formatAndLimitAssets = (assets, size) => {
  let returnedAssets = [];

  _.reverse(
    _.sortBy(
      assets,
      ['lastModified']
    )
  )
    .slice(0, size).forEach(asset => {
    const filename = asset.filePath.split('/')[1];

    const { base } = path.parse(asset.filePath)
    const split = base.split(".")

    // This logic is slightly modified from the original v1 implementation. Since the original logic
    // was built for drip-web-components.bundle.js we shouldn't be allowing any releases for assets
    // other than this specific filename.
    if (split[0] + "." + split[1] === "drip-web-components.bundle") {
      asset.checksum = filename.split('.')[2];
      asset.checksumDigest = asset.checksum.substr(0, 7);
      returnedAssets.push(asset);
    }
  });

  return returnedAssets;
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
      Key: asset.filePath
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

const addGitInfo = (asset, packageName) => {
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
        const checksumShort = utils.shortHash(asset.checksum);
        asset.displayName += (` | ${packageName}[${checksumShort}]`);
        return asset;
      }

      const author = commit.author();
      const commitDateStr = commit.date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const checksumShort = utils.shortHash(asset.checksum);
      const gitShaShort = utils.shortHash(gitSha);
      const gitBranch = _.isEmpty(asset.gitBranch) ? "" : _.truncate(asset.gitBranch, {length: 15});
      const gitMessage = _.truncate(commit.message(), {length: 30}).replace(/(\r\n|\n|\r)/gm, '');
      asset.displayName = `${commitDateStr} | ${packageName}[${checksumShort}] | ${author.name()} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;
      return asset;
    });
};

const determineAssetToRelease = (cmdObj, bucketNames, environment, bucketPath, packageName) => {
  const bucketName = _.get(bucketNames, environment.serverEnvironment);

  return getAssets(bucketName, bucketPath)
    .then(assets => {
      return formatAndLimitAssets(assets, 20); // Only show last 20 assets
    })
    .then(assets => {
      return Promise.all(assets.map(asset => addGitSha(asset)));
    })
    .then(assets => {
      return Promise.all(assets.map(asset => addGitInfo(asset, packageName)));
    })
    .then(assets => {
      if (assets.length === 0) {
        console.log("\n> There are no currently deployed drip-web-components. Run 'gurgler deploy <gitCommitSha> <gitBranch>' and try again.\n");
        process.exit(0);
      }
      if( _.isEmpty(cmdObj.commit)) {
        return inquirer.prompt([ {
            type: 'list',
            name: 'asset',
            message: 'Which deployed drip-web-components version would you like to release?',
            choices: assets.map(asset => {
                return {name: asset.displayName, value: asset}
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

          const asset = _.find(assets, asset => {
            return _.startsWith(asset.gitSha, cmdObj.commit)
          });

          // TODO If we do not find it in this list of assets, check older assets too.

          if (!asset) {
            console.error(`"${cmdObj.commit}" does not appear to be a valid checksum.`);
            process.exit(1);
          }

          resolve({asset: asset});
        }));
      }
    })
};

const confirmRelease = (environment, asset, packageName) => {
  return inquirer.prompt([{
    type: 'confirm',
    name: 'confirmation',
    message: `Do you want to release ${packageName} git[${asset.gitShaDigest}] checksum[${asset.checksumDigest}] to ${environment.key}?`,
    default: false
  }]).then(answers => {
    if (
      answers.confirmation && 
      environment.masterOnly && 
      asset.gitBranch !== 'master'
    ) {
      return inquirer.prompt([{
        type: 'confirm',
        name: 'confirmation',
        message: `Warning: You are attempting to release a non-master branch[${asset.gitBranch}] to a master-only environment[${environment.serverEnvironment}]. Do you wish to proceed?`,
      }])
    }
    return answers;
  })
};

/**
 * Update the value for the chosen environment in SSM.
 *
 * @param {object} environment
 * @param {object} asset
 */

const release = (environment, asset, packageName, slackConfig) => {
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
    sendReleaseMessage(environment, asset, packageName, slackConfig);
  });
};

/**
 * Sends a message when the Slack when a release happens.
 *
 * @param {object} environment The users chosen environment.
 * @param {object} asset The users chosen asset.
 */

const sendReleaseMessage = (environment, asset, packageName, slackConfig) => {
  const userDoingDeploy = process.env.USER;
  const simpleMessage = `\n> ${userDoingDeploy} successfully released the asset ${packageName}[${asset.gitSha}] to ${environment.key}\n`;

  if (slackConfig) {
    const slackMessage = [
      `*${userDoingDeploy}* successfully released a new ${packageName} asset to *${environment.key}*`,
      `_${asset.displayName}_`,
      `<${slackConfig.githubRepoUrl}/commit/${asset.gitSha}|View commit on GitHub>`,
    ].join("\n");
  
    const slackChannel = environment.slackChannel;
  
    if (!_.isEmpty(slackConfig.slackWebHookUrl) && !_.isEmpty(slackChannel)) {
      const webhook = new IncomingWebhook(slackConfig.slackWebHookUrl);
  
      (async () => {
        await webhook.send({
          username: slackConfig.slackUsername,
          text: slackMessage,
          icon_emoji: slackConfig.slackIconEmoji,
          channel: slackChannel
        })
      })().catch(err => console.error(err));
    }
  }

  console.log(simpleMessage);
};

const deployCmd = (bucketNames, bucketPath, localFilePaths, gitCommitSha, gitBranch) => {
  
  localFilePaths.forEach(localFilePath => {
    readFileAndDeploy( bucketNames, bucketPath, localFilePath, gitBranch, gitCommitSha );
  });
}

const releaseCmd = (cmdObj, bucketNames, environments, bucketPath, packageName, slackConfig) => {

  let environment;
  let asset;
  requestCurrentlyReleasedVersions(environments)
    .then(environments => {
      return determineEnvironment(cmdObj, environments)
    })
    .then(answers => {
      environment = answers.environment;
      return determineAssetToRelease(cmdObj, bucketNames, environment, bucketPath, packageName)
    })
    .then(answers => {
      asset = answers.asset;
      return confirmRelease(environment, asset, packageName);
    })
    .then(answers => {
      if (answers.confirmation) {
        release(environment, asset, packageName, slackConfig);
      } else {
        console.log("Cancelling release...");
      }
    })
    .catch(err => console.error(err));
}

module.exports = {
  deployCmd,
  releaseCmd,
}
