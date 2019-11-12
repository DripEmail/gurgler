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
const utils = require("./utils");

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

const readFileAndDeploy = (bucketNames, prefix, localFilePath, gitInfo) => {
  
  // TODO upload map file if it exists.

  // TODO send source maps to Honeybadger (but maybe just the ones we deploy)

  fs.readFile(localFilePath, (err, data) => {
    if (err) {
      throw err;
    }
    
    const { base, ext } = path.parse(localFilePath);
    const contentType = utils.getContentType(ext);

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
 * @param bucketPath
 * @returns {Promise<[{object}]>}
 */

const getDeployedVersionList = (bucketName, bucketPath) => {
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
        Prefix: bucketPath + "/",
      };

      if (token) {
        opts.ContinuationToken = token;
      }
      
      s3.listObjectsV2(opts, (err, data) => {
        if (err) {
          reject()
        }

        const concatenated = allVersions.concat(data.Contents);

        // This is not strictly necessary once v1 is removed. It does, however, provide some extra
        // assurance we're only ever getting the gurgler.json keys.
        allVersions = _.filter(concatenated, version => {
          const {base, ext} = path.parse(version.Key);
          return (ext === ".json" && base.split(".")[1] === "gurgler");
        })
        
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

const addGitInfo = (version, packageName) => {
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
        const checksumShort = utils.shortHash(version.checksum);
        version.displayName += (` | ${packageName}[${checksumShort}]`);
        return version;
      }

      const author = commit.author();
      const commitDateStr = commit.date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const checksumShort = utils.shortHash(version.checksum);
      const gitShaShort = utils.shortHash(gitSha);
      const gitBranch = _.isEmpty(version.gitBranch) ? "" : _.truncate(version.gitBranch, {length: 15});
      const gitMessage = _.truncate(commit.message(), {length: 30}).replace(/(\r\n|\n|\r)/gm, '');
      version.displayName = `${commitDateStr} | ${packageName}[${checksumShort}] | ${author.name()} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;
      return version;
    });
};

const determineVersionToRelease = (cmdObj, bucketNames, environment, bucketPath, packageName) => {
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
      return Promise.all(versions.map(version => addGitInfo(version, packageName)));
    })
    .then(versions => {
      if (versions.length === 0) {
        console.log("\n> There are no currently deployed versions. Run 'gurgler configure <gitCommitSha> <gitBranch>' and `gurgler deploy` and try again.\n");
        process.exit(0);
      }
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

/**
 * Sends a message when the Slack when a release happens.
 *
 * @param {object} environment The users chosen environment.
 * @param {object} version The users chosen version.
 */

const sendReleaseMessage = (environment, version, packageName, slackConfig) => {
  const userDoingDeploy = process.env.USER;
  const simpleMessage = `\n> ${userDoingDeploy} successfully released the version ${packageName}[${version.gitSha}] to ${environment.key}\n`;

  if (slackConfig) {
    const slackMessage = [
      `*${userDoingDeploy}* successfully released a new ${packageName} version to *${environment.key}*`,
      `_${version.displayName}_`,
      `<${slackConfig.githubRepoUrl}/commit/${version.gitSha}|View commit on GitHub>`,
    ].join("\n");
  
    const slackChannel = environment.slackChannel;
  
    if (!_.isEmpty(slackConfig.slackWebHookUrl) && !_.isEmpty(slackChannel)) {
      const webhook = new IncomingWebhook(slackWebHookUrl);
  
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

/**
 * Update the value for the chosen environment in SSM.
 *
 * @param {object} environment
 * @param {object} version
 */

const release = (environment, version, packageName, slackConfig) => {
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
    sendReleaseMessage(environment, version, packageName, slackConfig);
  });
};

const confirmRelease = (environment, version, packageName) => {
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

const configureCmd = (gurglerPath, bucketPath, commit, branch) => {
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
}

const deployCmd = (bucketNames, gurglerPath, globs) => {
  fs.readFile(gurglerPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        console.log("Either gurgler.json has not been built or it has been removed. Run 'gurgler configure <git commit sha> <git branch>' and try again.");
      }
      throw err;
    }

    let localFilePaths = [gurglerPath];
    
    globs.forEach(globb => {
      localFilePaths = localFilePaths.concat(glob.sync(globb.pattern, {
        ignore: globb.ignore
      }))
    })

    const { prefix, raw } = JSON.parse(data)

    localFilePaths.forEach(localFilePath => {
      readFileAndDeploy(bucketNames, prefix, localFilePath, raw);
    });
  });
}

const releaseCmd = (cmdObj, bucketNames, environments, bucketPath, packageName, slackConfig) => {

  let environment;
  let version;

  requestCurrentlyReleasedVersions(environments)
    .then(environments => {
      return determineEnvironment(cmdObj, environments)
    })
    .then(answers => {
      environment = answers.environment;
      return determineVersionToRelease(cmdObj, bucketNames, environment, bucketPath, packageName)
    })
    .then(answers => {
      version = answers.version;
      return confirmRelease(environment, version, packageName);
    })
    .then(answers => {
      if (answers.confirmation) {
        release(environment, version, packageName, slackConfig);
      } else {
        console.log("Cancelling release...");
      }
    })
    .catch(err => console.error(err));
}

module.exports = {
  configureCmd,
  deployCmd,
  releaseCmd
}
