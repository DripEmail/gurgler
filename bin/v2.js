const fs = require('fs');
const AWS = require('aws-sdk');
const inquirer = require('inquirer');
const path = require('path');
const _ = require('lodash');
const crypto = require('crypto');
const {IncomingWebhook} = require('@slack/webhook');
const glob = require("glob");
const utils = require("./utils");
const {getGitInfo} = require("./git");
const {emptyS3Directory, makeHashDigest} = require("./utils");

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
 * @param {Boolean} pretend
 */

const readFileAndDeploy = (bucketNames, prefix, localFilePath, gitInfo, pretend = false) => {

  // TODO upload map file if it exists.

  // TODO send source maps to Honeybadger (but maybe just the ones we deploy)

  fs.readFile(localFilePath, (err, data) => {
    if (err) {
      throw err;
    }

    const {base, ext} = path.parse(localFilePath);
    const contentType = utils.getContentType(ext);

    let remoteFilePath;
    if (base === "gurgler.json") {
      // prefix.gurgler.json is a sibling to the prefix under which all the assets are keyed.
      remoteFilePath = `${prefix}.${base}`
    } else {
      remoteFilePath = path.join(prefix, base);
    }

    _.forEach(bucketNames, (bucketName) => {
      if (pretend) {
        console.log(`Only pretending to deploy ${localFilePath} to S3 bucket ${bucketName} ${remoteFilePath}`);
      } else {
        const s3 = new AWS.S3({
          apiVersion: '2006-03-01', params: {Bucket: bucketName}
        });

        // noinspection JSCheckFunctionSignatures
        s3.upload({
          Key: remoteFilePath,
          Body: data,
          ACL: 'public-read',
          Metadata: {'git-info': gitInfo},
          ContentType: contentType,
        }, (err) => {
          if (err) {
            throw err;
          }
          console.log(`Successfully deployed ${localFilePath} to S3 bucket ${bucketName} ${remoteFilePath}`);
        });
      }

    });
  });
};

/**
 * Get the currently released values for all the environments.
 *
 * @param environments
 * @returns {Promise<[{object}]>}
 */

const requestCurrentlyReleasedVersions = (environments) => {

  // noinspection JSUnresolvedVariable
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
        // noinspection JSUnresolvedVariable
        const value = _.find(data.Parameters, v => env.ssmKey === v.Name);

        env.releasedHash = _.get(value, "Value", "Unreleased!");
        env.releaseHashShort = env.releasedHash === "Unreleased!" ? "Unreleased!" : utils.makeHashDigest(env.releasedHash)
        env.releaseDateStr = _.get(value, "LastModifiedDate");

        return env;
      });

      return resolve(environmentsWithReleaseData);
    });
  });
};

const determineEnvironment = (cmdObj, environments) => {
  if (_.isEmpty(cmdObj.environment)) {
    return inquirer.prompt([{
      type: 'list',
      name: 'environment',
      message: 'Which environment will receive this release?',
      choices: environments.map(env => {
        const label = _.padEnd(env.label, 12);
        return {
          name: `${label} ${env.releaseHashShort}`, value: env
        }
      })
    }]);
  } else {
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
        Bucket: bucketName, // We want all gurgler.json keys, not any of the actual asset keys.
        Delimiter: "/", Prefix: bucketPath + "/",
      };

      if (token) {
        opts.ContinuationToken = token;
      }

      s3.listObjectsV2(opts, (err, data) => {
        if (err) {
          reject()
        }

        const concatenated = allVersions.concat(data.Contents);

        // Make sure we're only ever pulling our gurgler.json manifest files.
        allVersions = _.filter(concatenated, version => {
          const {base, ext} = path.parse(version.Key);
          return (ext === ".json" && base.split(".")[1] === "gurgler");
        })

        if (data.IsTruncated) {
          listAllVersions(data.NextContinuationToken);
        } else {
          resolve(allVersions.map(version => {
            return {
              filepath: version.Key,
              directoryPath: version.Key.split(".gurgler.json")[0],
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

const getDeployedVersionListWithMetadata = (bucketName, bucketPath, packageName) => {

  const filterFilesToFindGurglerDeploys = async (versions) => {
    let artifacts = [];
    for (const version of versions) {
      const {base, ext} = path.parse(version.filepath);
      const split = base.split(".");

      if (ext === ".json" && split[1] === "gurgler") {
        version.hash = split[0];
        version.hashDigest = makeHashDigest(version.hash);
        version.dirFilepath = split[0];
        artifacts.push(version);
      }
    }
    return Promise.resolve(artifacts)
  }

  const decorateArtifactsWithGitInfo = async (versions) => {
    let artifacts = [];
    for (const version of versions) {
      const artifact = await addGitInfo(version, packageName);
      artifacts.push(artifact);
    }
    return Promise.resolve(artifacts)
  }

  return getDeployedVersionList(bucketName, bucketPath)
    .then(versions => {
      return _.sortBy(versions, ['lastModified'])
    })
    .then(filterFilesToFindGurglerDeploys)
    .then(versions => {
      return Promise.all(versions.map(version => {
        return addGitSha(version)
      }));
    })
    .then(decorateArtifactsWithGitInfo)
}

/**
 * Sort the list of versions so the latest are first then return a slice of the first so many.
 *
 * @param versions
 * @param size
 * @returns {[{object}]}
 */

const formatAndLimitDeployedVersions = (versions, size) => {
  const returnedVersions = [];

  _.reverse(_.sortBy(versions, ['lastModified']))
    .slice(0, size).forEach(version => {

    const {base, ext} = path.parse(version.filepath);
    const split = base.split(".");

    // This check is strictly not necessary assuming getDeployedVersionList only returns versions
    // matching these criteria.
    if (ext === ".json" && split[1] === "gurgler") {
      version.hash = split[0];
      version.hashDigest = makeHashDigest(version.hash);
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

const addGitSha = async (version) => {
  const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
  });

  return new Promise((resolve, reject) => {
    s3.headObject({
      Bucket: version.bucket, Key: version.filepath
    }, (err, data) => {
      if (err) {
        return reject(err);
      }

      const metaData = data.Metadata['git-info'];
      if (metaData !== '' && metaData !== undefined) {
        const parsedMetaData = metaData.split('|');
        version.gitSha = parsedMetaData[0];
        version.gitShaDigest = makeHashDigest(parsedMetaData[0]);
        version.gitBranch = parsedMetaData[1];
      }
      return resolve(version);
    });
  });
};

const addGitInfo = async (version, packageName) => {
  const gitSha = version.gitSha;

  const gitInfo = await getGitInfo(gitSha);

  const author = gitInfo.get("author").padEnd(16);
  const commitDateStr = gitInfo.get("date").padEnd(16);
  const hashShort = utils.makeHashDigest(version.hash);
  const gitShaShort = utils.makeHashDigest(gitSha);
  const gitBranch = _.isEmpty(version.gitBranch) ? "" : _.truncate(version.gitBranch, {length: 15});
  const gitMessage = _.truncate(gitInfo.get("message"), {length: 30}).replace(/(\r\n|\n|\r)/gm, '');
  version.displayName = `${commitDateStr} | ${packageName}[${hashShort}] | ${author} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;

  return version;
};

const determineVersionToRelease = (cmdObj, bucketNames, environment, bucketPath, packageName) => {
  // noinspection JSUnresolvedVariable
  const bucketName = _.get(bucketNames, environment.serverEnvironment);
  if (!bucketName) {
    // noinspection JSUnresolvedVariable
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
      if (_.isEmpty(cmdObj.commit)) {
        return inquirer.prompt([{
          type: 'list',
          name: 'version',
          message: 'Which deployed version would you like to release?',
          choices: versions.map(version => {
            return {name: version.displayName, value: version}
          })
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
 * @param packageName
 * @param slackConfig
 */

const sendReleaseMessage = (environment, version, packageName, slackConfig) => {
  const userDoingDeploy = process.env.USER;
  const simpleMessage = `\n> ${userDoingDeploy} successfully released the version ${packageName}[${version.gitSha}] to ${environment.key}\n`;

  if (slackConfig) {
    const slackMessage = [`*${userDoingDeploy}* successfully released a new ${packageName} version to *${environment.key}*`, `_${version.displayName}_`, `<${slackConfig.githubRepoUrl}/commit/${version.gitSha}|View commit on GitHub>`,].join("\n");

    // noinspection JSUnresolvedVariable
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

/**
 * Update the value for the chosen environment in SSM.
 *
 * @param {object} environment
 * @param {object} version
 * @param {object} lambdaFunctions
 * @param {string} packageName
 * @param {object} slackConfig
 */

const release = (environment, version, lambdaFunctions, packageName, slackConfig) => {
  const lambda = new AWS.Lambda({
    apiVersion: '2015-03-31'
  });

  if (!_.has(environment, 'serverEnvironment')) {
    throw new Error(`The server environment for this environment is not set: ${environment.key}`);
  }

  // noinspection JSUnresolvedVariable
  if (!_.has(lambdaFunctions, environment.serverEnvironment)) {
    // noinspection JSUnresolvedVariable
    throw new Error(`the lambda function for the following environment is not set: ${environment.serverEnvironment}`);
  }

  // noinspection JSUnresolvedVariable
  const functionName = lambdaFunctions[environment.serverEnvironment];

  // noinspection JSUnresolvedVariable
  const params = {
    FunctionName: functionName, InvocationType: "RequestResponse", Payload: JSON.stringify({
      parameterName: environment.ssmKey, parameterValue: version.hash,
    })
  }

  lambda.invoke(params, (err, data) => {
    if (err) {
      throw err;
    }
    if (data.StatusCode !== 200) {
      throw new Error(`unsuccessful lambda invocation; unable to release asset version; got status ${data.StatusCode}`);
    }
    if (data.FunctionError) {
      throw new Error(`one or more parameter store values could not be updated: ${data.Payload}`);
    }
    sendReleaseMessage(environment, version, packageName, slackConfig);
  });
};

const confirmRelease = (environment, version, packageName) => {
  return inquirer.prompt([{
    type: 'confirm',
    name: 'confirmation',
    message: `Do you want to release ${packageName} git[${version.gitShaDigest}] hash[${version.hashDigest}] to ${environment.key}?`,
    default: false
  }]).then(answers => {
    // noinspection JSUnresolvedVariable
    if (answers.confirmation && environment.masterOnly && version.gitBranch !== 'master') {
      // noinspection JSUnresolvedVariable
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
    commit, branch, raw, hash: hashed, prefix,
  }, null, 2);

  fs.writeFile(gurglerPath, data, err => {
    if (err) {
      throw err
    }
    console.log(`gurgler successfully configured; the current build info can be found at ${gurglerPath}\n`);
  })
}

/**
 *
 * @param bucketNames
 * @param gurglerPath
 * @param globs
 * @param pretend {boolean}
 */
const deployCmd = (bucketNames, gurglerPath, globs, pretend = false) => {
  fs.readFile(gurglerPath, 'utf-8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        console.log("Either gurgler.json has not been built or it has been removed. Run 'gurgler configure <git commit sha> <git branch>' and try again.");
      }
      throw err;
    }

    let localFilePaths = [gurglerPath];

    globs.forEach(aGlob => {
      localFilePaths = localFilePaths.concat(glob.sync(aGlob.pattern, {
        ignore: aGlob.ignore
      }))
    })

    const {prefix, raw} = JSON.parse(data)

    localFilePaths.forEach(localFilePath => {
      readFileAndDeploy(bucketNames, prefix, localFilePath, raw, pretend);
    });
  });
}

const releaseCmd = (cmdObj, bucketNames, lambdaFunctions, environments, bucketPath, packageName, slackConfig) => {
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
      // noinspection JSUnresolvedVariable
      if (answers.confirmation) {
        release(environment, version, lambdaFunctions, packageName, slackConfig);
      } else {
        console.log("Cancelling release...");
      }
    })
    .catch(err => console.error(err));
}

const cleanupCmd = async (cmdObj, bucketNames, lambdaFunctions, environments, bucketPath, packageName) => {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - (1000 * 60 * 60 * 24 * 90));

  // This line might be too clever. It's getting all the server environments and then getting an array of just the unique ones.
  // noinspection JSUnresolvedVariable
  const serverEnvironments = [...new Set(environments.map(environment => environment.serverEnvironment))];

  const confirmationQuestions = serverEnvironments.map(serverEnvironment => {
    const bucketName = _.get(bucketNames, serverEnvironment);
    return {
      type: 'confirm',
      name: serverEnvironment,
      message: `Do you want to clean up the gurgler assets in the S3 bucket ${bucketName} with the path: ${bucketPath}?`,
      default: false
    }
  });

  inquirer.prompt(confirmationQuestions).then(answers => {
    serverEnvironments.map(serverEnvironment => {
      if (answers[serverEnvironment]) {
        const bucketName = _.get(bucketNames, serverEnvironment);
        console.log(`Cleaning up gurgler assets in the S3 bucket ${bucketName} with the path: ${bucketPath} `);

        requestCurrentlyReleasedVersions(environments).then(releasedVersions => {
          return getDeployedVersionListWithMetadata(bucketName, bucketPath, packageName).then(deployedArtifacts => {

            console.log(`There are currently a total of ${deployedArtifacts.length} deployed artifacts in ${serverEnvironment}.`);

            const oldArtifacts = deployedArtifacts
              .filter(artifact => {
                // only allow an asset to be deleted if it's older than a year
                return artifact.lastModified.getTime() < ninetyDaysAgo.getTime()
              })
              .filter(artifact => {
                // only allow an asset to be deleted if it's not being used in any of the environments
                for (const releasedVersion of releasedVersions) {
                  // noinspection JSUnresolvedVariable
                  if (releasedVersion.releasedHash === artifact.hash) {
                    return false;
                  }
                }
                return true;
              })
            console.log(`We are going to delete ${oldArtifacts.length} ${packageName} artifact(s) in ${serverEnvironment}`);

            return oldArtifacts;
          })
        }).then(artifactsToDelete => {

          if (artifactsToDelete.length < 1) {
            console.log("Nothing to delete.")
          }

          for (const artifact of artifactsToDelete) {
            console.log(artifact.displayName);
          }
          inquirer.prompt({
            type: 'confirm',
            name: "reallyDelete",
            message: `Really delete these assets in the S3 bucket ${bucketName} with the path: ${bucketPath}?`,
            default: false
          }).then(answers => {
            // noinspection JSUnresolvedVariable
            if (answers.reallyDelete) {
              for (const artifact of artifactsToDelete) {

                console.log("Deleting", artifact.hash);

                const s3 = new AWS.S3({
                  apiVersion: '2006-03-01'
                });

                emptyS3Directory(s3, bucketName, artifact.directoryPath);

                const paramsOfObjectsToDelete = {
                  Bucket: bucketName, Delete: {
                    Objects: [{
                      Key: artifact.filepath
                    }, {
                      Key: artifact.directoryPath
                    }],
                  }
                };

                s3.deleteObjects(paramsOfObjectsToDelete, function (err, data) {
                  if (err) console.error(err, err.stack); // an error occurred
                  else console.log(data);           // successful response
                });
              }
              console.log("Deleted.")
            } else {
              console.log("Very well, not deleting anything then.")
            }
          })

        })
      }
    });
  });
}


module.exports = {
  configureCmd, deployCmd, releaseCmd, cleanupCmd
}
