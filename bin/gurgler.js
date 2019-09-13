#! /usr/bin/env node
const fs = require('fs');
const AWS = require('aws-sdk');
const inquirer = require('inquirer');
const program = require('commander');
const path = require('path');
const _ = require('lodash');
const crypto = require('crypto');
const NodeGit = require('nodegit');


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


const currentlyReleasedChecksum = (parameters, environment) => {

  const currentlyReleasedChecksum = _.result(_.find(parameters, (parameter) => {
    return parameter.Name === environment.ssmKey;
  }), 'Value');

  if (currentlyReleasedChecksum === '' || currentlyReleasedChecksum === undefined) {
    return ' | (Unreleased!)';
  }
  // TODO make 'elm' something... else
  return ' | elm[' + currentlyReleasedChecksum.substring(0, 7) + ']';
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
        console.log('Warning, could not get commit: git[' + gitSha + '],', err.message.replace(/(\r\n|\n|\r)/gm, ''));
      }
      return undefined;
    })
    .then(commit => {
      if (commit === undefined) {
        asset.displayName = asset.lastModified.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        asset.displayName += (' | elm[' + asset.checksum.substring(0, 7) + ']');
        return asset;
      }

      const author = commit.author();
      asset.displayName = commit.date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      asset.displayName += (' | elm[' + asset.checksum.substring(0, 7) + ']');
      asset.displayName += (' | ' + author.name());
      asset.displayName += (' | git[' + gitSha.substring(0, 7) + ']');
      asset.displayName += (' | ');
      if (asset.gitBranch !== '' && asset.gitBranch !== undefined) {
        asset.displayName += ('[' + _.truncate(asset.gitBranch, {length: 15}) + '] ');
      }
      asset.displayName += (_.truncate(commit.message(), {length: 30}).replace(/(\r\n|\n|\r)/gm, ''));
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

// TODO Pass in any cli parameters and skip the questions when possible.
const askQuestions = (environments, assets, parameters, environmentKey, checksum) => {

  const questions = [];

  if (environmentKey) {
    const environment = _.find(environments, e => e.key === environmentKey);
    if (!environment) {
      const keys = environments.map(e => e.key);
      const keysStr = _.join(keys, ", ");
      console.error(`"${environmentKey}" does not appear to be a valid environment. The choices are: ${keysStr}`);
      process.exit(1);
    }
  }
  else {
    questions.push(
      {
        type: 'list',
        name: 'environment',
        message: 'Which environment will receive this release?',
        choices: environments.map(env => {
          const checksum = currentlyReleasedChecksum(parameters, env);
          return {
            name: `${env.label} ${checksum}`,
            value: env.key
          }
        })
      }
    )
  }

  if (checksum) {
    // TODO Check checksum
  }
  else {
    questions.push(
      {
        type: 'list',
        name: 'checksum',
        message: 'Which deployed version would you like to release?',
        choices: assets.map(asset => {
          return { name: asset.displayName, value: asset.checksum }
        })
      }
    )
  }

  return inquirer.prompt(questions).then(answers => {
    const asset = _.find(assets, (asset) => {
      return asset.checksum === answers.checksum;
    });
    return _.merge(answers, { asset: asset });
  });
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
  .option("-c, --checksum <checksum>", "the checksum of the asset to deploy")
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
        return askQuestions(environments, assets, parameters, cmdObj.environment, cmdObj.checksum);
      })
      .catch(err => console.error(err));

  });

program.parse(process.argv);
