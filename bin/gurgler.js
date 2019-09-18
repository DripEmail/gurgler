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

AWS.config.update({
  region: bucketRegion
});

/**
 * *****************
 * Utility functions
 * *****************
 */

/**
 * Send the asset up to S3.
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

  //TODO upload map file if it exists.

  // TODO send source maps to Honeybadger (but maybe just the ones we deploy)

  fs.readFile(localFilePath, (err, data) => {
    if (err) {
      throw err;
    }

    hash.update(data);
    const checksum = hash.digest('hex');
    const remoteFilePath = path.join(bucketPath, `${fileName}.${checksum}.js`);

    bucketNames.forEach(function (bucketName) {
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

const getAssets = (bucketName, prefix) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    let allKeys = [];

    const listAllKeys = (token) => {
      const opts = {
        Bucket: bucketName,
        Prefix: prefix,
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
          resolve(allKeys.map(asset => {
            return {
              filePath: asset.Key,
              lastModified: asset.LastModified,
              bucket: bucketName
            };
          }));
        }
      });
    };
    listAllKeys();
  });
};

const currentlyReleasedSummary = (parameters, environment) => {

  const currentlyReleasedChecksum = _.result(_.find(parameters, (parameter) => {
    return parameter.Name === environment.ssmKey;
  }), 'Value');

  const currentlyReleasedStr = _.isEmpty(currentlyReleasedChecksum) ? "Unreleased!" : currentlyReleasedChecksum.substring(0, 7);

  return ` | ${packageName}[${currentlyReleasedStr}]`;
};

const formatAndLimitAssets = (assets, size) => {
  const returnedAssets = [];

  _.reverse(
    _.sortBy(
      assets,
      ['lastModified']
    )
  )
    .slice(0, size).forEach(asset => {
    const filename = asset.filePath.split('/')[1];

    if (filename !== '' && filename !== undefined) {
      asset.checksum = filename.split('.')[2];
      asset.checksumDigest = asset.checksum.substr(0, 7);
      returnedAssets.push(asset);
    }
  });

  return returnedAssets;
};

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
        const checksumShort = asset.checksum.substring(0, 7);
        asset.displayName += (` | ${packageName}[${checksumShort}]`);
        return asset;
      }

      const author = commit.author();
      const commitDateStr = commit.date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const checksumShort = asset.checksum.substring(0, 7);
      const gitShaShort = gitSha.substring(0, 7);
      const gitBranch = _.isEmpty(asset.gitBranch) ? "" : _.truncate(asset.gitBranch, {length: 15});
      const gitMessage = _.truncate(commit.message(), {length: 30}).replace(/(\r\n|\n|\r)/gm, '');
      asset.displayName = `${commitDateStr} | ${packageName}[${checksumShort}] | ${author.name()} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;
      return asset;
    });
};

const currentParameters = (ssmKeys, assets) => {
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

      return resolve({
        assets: assets,
        parameters: data.Parameters
      });
    });
  });
};

const askQuestions = (environments, assets, parameters, environmentKey, commit) => {

  const questions = [];
  let answers = {};

  if (environmentKey) {
    const environment = _.find(environments, e => e.key === environmentKey);
    if (!environment) {
      const keys = environments.map(e => e.key);
      const keysStr = _.join(keys, ", ");
      console.error(`"${environmentKey}" does not appear to be a valid environment. The choices are: ${keysStr}`);
      process.exit(1);
    }
    answers.environment = environment;
  }
  else {
    questions.push(
      {
        type: 'list',
        name: 'environment',
        message: 'Which environment will receive this release?',
        choices: environments.map(env => {
          const checksum = currentlyReleasedSummary(parameters, env);
          const label = _.padEnd(env.label, 12);
          return {
            name: `${label} ${checksum}`,
            value: env.key
          }
        })
      }
    )
  }

  if (commit) {
    if (commit.length < 7) {
      console.error(`The checksum "${commit}" is not long enough, it should be at least 7 characters.`);
      process.exit(1);
    }

    const asset = _.find(assets, asset => {
      return _.startsWith(asset.gitSha, commit)
    });

    // TODO If we do not find it in this list of assets, check older assets too.

    if (!asset) {
      console.error(`"${commit}" does not appear to be a valid checksum.`);
      process.exit(1);
    }

    answers.commit = commit;
  }
  else {
    questions.push({
      type: 'list',
      name: 'commit',
      message: 'Which deployed version would you like to release?',
      choices: assets.map(asset => {
        return { name: asset.displayName, value: asset.gitSha }
      })
    });
  }

  return inquirer.prompt(questions).then(questionAnswers => {
    answers =  _.merge(answers, questionAnswers);

    answers.asset = _.find(assets, (asset) => {
      return asset.gitSha === answers.commit;
    });

    return answers;
  });
};


const confirmRelease = (environment, asset) => {

  console.log("asset", asset);

  const questions = [
    {
      type: 'confirm',
      name: 'confirmation',
      message: `Do you want to release ${packageName} git[${asset.gitShaDigest}] checksum[${asset.checksumDigest}] to ${environment.key}?`,
      default: false
    }
  ];

  return inquirer.prompt(questions).then(answers => {
    if (answers.confirmation) {
      //release(environment, checksum, asset);
    } else {
      console.log("Cancelling release...");
    }
  });
};

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
  ssm.putParameter(ssmParams, (err, data) => {
    if (err) {
      throw err;
    }
    sendReleaseMessage(environment, asset);
  });
};

const sendReleaseMessage = (environment, asset) => {
  const userDoingDeploy = process.env.USER;
  const simpleMessage = `${userDoingDeploy} successfully released elm asset ${packageName}[] to ${environment.key}`;

  const slackMessage = [
    `*${userDoingDeploy}* successfully released a new ${packageName} asset to *${environment.key}*`,
    `_${asset.displayName}`,
    `<https://github.com/DripEmail/drip-elm/commit/${asset.gitSha}|View commit on GitHub>`,
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
    })();
  }

  console.log(simpleMessage);
};



/**
 * *****************
 * The "main" part of the program.
 * *****************
 */


program
  .command('deploy <gitCommitSha> <gitBranch> ')
  .description('sends a new asset (at a particular commit on a particular branch) to the S3 bucket')
  .action((gitCommitSha, gitBranch) => {
    localFilePaths.forEach(localFilePath => {
      // TODO verify the parameters (gitCommitSha, gitBranch)
      readFileAndDeploy( bucketNames, bucketPath, localFilePath, gitBranch, gitCommitSha );
    });

  });


program
  .command('release')
  .description('takes a previously deployed asset a turns it on for a particular environment')
  .option("-e, --environment <environment>", "environment to deploy to")
  .option("-c, --commit <gitSha>", "the git sha (commit) of the asset to deploy")
  .action((cmdObj) => {
    // Get all the assets from all the buckets
    Promise.all(
      bucketNames.map(bucketName => getAssets(bucketName, bucketPath))
    )
      .then(assetsLists => {
      // Merge all the assets from all the buckets into 1 array
      return new Promise((resolve) => {
        resolve(_.unionWith(...assetsLists, _.isEqual))
      });
      })
      .then(assets => {
        return formatAndLimitAssets(assets, 20); // Only show last 20 assets
      })
      .then(assets => {
        return Promise.all(assets.map(asset => addGitSha(asset)));
      })
      .then(assets => {
        return Promise.all(assets.map(asset => addGitInfo(asset)));
      })
      .then(assets => {
        const ssmKeys = environments.map(env => env.ssmKey);
        return currentParameters(ssmKeys, assets);
      })
      .then(({ assets, parameters }) => {
        return askQuestions(environments, assets, parameters, cmdObj.environment, cmdObj.commit);
      }).then(({environment, commit, asset}) => {
        confirmRelease(environment, asset)
      })
      .catch(err => console.error(err));

  });

program.parse(process.argv);
