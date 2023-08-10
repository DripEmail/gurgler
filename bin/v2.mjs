import inquirer from "inquirer";
import { join, parse } from "path";
import { emptyS3Directory, getContentType, makeHashDigest } from "./utils.mjs";
import _ from "lodash";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getGitInfo } from "./git.mjs";
import { IncomingWebhook } from "@slack/webhook";
import { glob } from "glob";
import { createHash } from "crypto";
import { writeFile } from "fs";
import { readFile } from "node:fs/promises";
import * as utils from "./utils.mjs";

/**
 * Send the file to S3. All files except gurgler.json are considered assets and will be prefixed with
 * the appropriate value. If there are more than 1 hierarchy to the prefix, gurgler.json will maintain
 * all prefixes save the last, to which it will be appended. For example, a prefix of assets/asdsf will
 * result in all assets being stored within that prefix but gurgler.json will become assets/asdf.gurgler.json.
 *
 * @param {array} bucketNames
 * @param {string} prefix
 * @param {string} localFilePath
 * @param {string} gitInfo
 * @param {Boolean} pretend
 */

const readFileAndDeploy = async (
  bucketNames,
  prefix,
  localFilePath,
  gitInfo,
  pretend = false
) => {
  // TODO upload map file if it exists.

  const data = await readFile(localFilePath);
  const { base, ext } = parse(localFilePath);
  const contentType = getContentType(ext);

  let remoteFilePath;
  if (base === "gurgler.json") {
    // prefix.gurgler.json is a sibling to the prefix under which all the assets are keyed.
    remoteFilePath = `${prefix}.${base}`;
  } else {
    remoteFilePath = join(prefix, base);
  }

  for (const bucketName in bucketNames) {
    if (pretend) {
      console.log(
        `Only pretending to deploy ${localFilePath} to S3 bucket ${bucketNames[bucketName]} ${remoteFilePath}`
      );
    } else {
      const client = new S3Client();
      const input = {
        Key: remoteFilePath,
        Body: data,
        Bucket: bucketNames[bucketName],
        ACL: "public-read",
        Metadata: { "git-info": gitInfo },
        ContentType: contentType,
      };

      const command = new PutObjectCommand(input);
      await client.send(command);

      console.log(
        `Successfully deployed ${localFilePath} to S3 bucket ${bucketNames[bucketName]} ${remoteFilePath}`
      );
    }
  }
};

/**
 * Get the currently released values for all the environments.
 *
 * @param environments
 * @returns {Promise<[{object}]>}
 */

const requestCurrentlyReleasedVersions = async (environments) => {
  // noinspection JSUnresolvedVariable
  const ssmKeys = environments.map((env) => env.ssmKey);

  const ssmClient = new SSMClient();

  const params = {
    Names: ssmKeys,
  };

  // Get data about what's currently released for each environment.
  const command = new GetParametersCommand(params);
  const response = await ssmClient.send(command);

  const environmentsWithReleaseData = environments.map((environment) => {
    const param = response.Parameters.find(
      (param) => param.Name === environment.ssmKey
    );

    const {
      Value: releasedHash = "Unreleased!",
      LastModifiedDate: releaseDate,
    } = param;

    // Fold in the data from SSM into the environment.
    const releaseDateShort =
      releasedHash === "Unreleased!"
        ? "Unreleased!"
        : utils.makeHashDigest(releasedHash);
    environment.releasedHash = releasedHash;
    environment.releaseHashShort = releaseDateShort;
    environment.releaseDate = releaseDate;
    environment.releaseDateStr = releaseDate.toDateString();

    return environment;
  });

  return environmentsWithReleaseData;
};

const determineEnvironment = (cmdObj, environments) => {
  if (_.isEmpty(cmdObj.environment)) {
    return inquirer.prompt([
      {
        type: "list",
        name: "environment",
        message: "Which environment will receive this release?",
        choices: environments.map((env) => {
          const label = _.padEnd(env.label, 12);
          return {
            name: `${label} ${env.releaseHashShort}`,
            value: env,
          };
        }),
      },
    ]);
  } else {
    return new Promise((resolve) => {
      const environment = _.find(
        environments,
        (e) => e.key === cmdObj.environment
      );
      if (!environment) {
        const keys = environments.map((e) => e.key);
        const keysStr = join(keys, ", ");
        console.error(
          `"${cmdObj.environment}" does not appear to be a valid environment. The choices are: ${keysStr}`
        );
        process.exit(1);
      }
      resolve({ environment: environment });
    });
  }
};

/**
 * Get all the assets in a bucket with a particular prefix (which essentially acts like a file path).
 * @param bucketName
 * @param bucketPath
 * @returns {Promise<[{object}]>}
 */

const getDeployedVersionList = async (bucketName, bucketPath) => {
  const client = new S3Client();

  const input = {
    Bucket: bucketName, // We want all gurgler.json keys, not any of the actual asset keys.
    Delimiter: "/",
    Prefix: bucketPath + "/",
  };

  let allVersions = [];

  // Get the first batch.
  const command = new ListObjectsV2Command(input);
  let response = await client.send(command);
  allVersions = allVersions.concat(response.Contents);

  while (response.IsTruncated) {
    // If there's more get those too
    input.ContinuationToken = response.NextContinuationToken;
    const innerCommand = new ListObjectsV2Command(input);
    response = await client.send(innerCommand);

    allVersions = allVersions.concat(response.Contents);
  }

  // Make sure we're only ever pulling our gurgler.json manifest files.
  allVersions = allVersions.filter((version) => {
    const { base, ext } = parse(version.Key);
    return ext === ".json" && base.split(".")[1] === "gurgler";
  });

  return allVersions.map((version) => {
    return {
      filepath: version.Key,
      directoryPath: version.Key.split(".gurgler.json")[0],
      lastModified: version.LastModified,
      bucket: bucketName,
    };
  });
};

const getDeployedVersionListWithMetadata = (
  bucketName,
  bucketPath,
  packageName
) => {
  const filterFilesToFindGurglerDeploys = async (versions) => {
    let artifacts = [];
    for (const version of versions) {
      const { base, ext } = parse(version.filepath);
      const split = base.split(".");

      if (ext === ".json" && split[1] === "gurgler") {
        version.hash = split[0];
        version.hashDigest = makeHashDigest(version.hash);
        version.dirFilepath = split[0];
        artifacts.push(version);
      }
    }
    return Promise.resolve(artifacts);
  };

  const decorateArtifactsWithGitInfo = async (versions) => {
    let artifacts = [];
    for (const version of versions) {
      const artifact = await addGitInfo(version, packageName);
      artifacts.push(artifact);
    }
    return Promise.resolve(artifacts);
  };

  return getDeployedVersionList(bucketName, bucketPath)
    .then((versions) => {
      return _.sortBy(versions, ["lastModified"]);
    })
    .then(filterFilesToFindGurglerDeploys)
    .then((versions) => {
      return Promise.all(
        versions.map((version) => {
          return addGitSha(version);
        })
      );
    })
    .then(decorateArtifactsWithGitInfo);
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

  _.reverse(_.sortBy(versions, ["lastModified"]))
    .slice(0, size)
    .forEach((version) => {
      const { base, ext } = parse(version.filepath);
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
  const client = new S3Client();
  const input = {
    Bucket: version.bucket,
    Key: version.filepath,
  };
  const command = new HeadObjectCommand(input);

  const response = await client.send(command);

  const metaData = response.Metadata["git-info"];
  if (metaData !== "" && metaData !== undefined) {
    const parsedMetaData = metaData.split("|");
    version.gitSha = parsedMetaData[0];
    version.gitShaDigest = makeHashDigest(parsedMetaData[0]);
    version.gitBranch = parsedMetaData[1];
  }

  return version;
};

const addGitInfo = async (version, packageName) => {
  const gitSha = version.gitSha;

  const gitInfo = await getGitInfo(gitSha);

  const author = gitInfo.get("author").padEnd(16);
  const commitDateStr = gitInfo.get("date").padEnd(16);
  const hashShort = makeHashDigest(version.hash);
  const gitShaShort = makeHashDigest(gitSha);
  const gitBranch = _.isEmpty(version.gitBranch)
    ? ""
    : _.truncate(version.gitBranch, { length: 15 });
  const gitMessage = _.truncate(gitInfo.get("message"), { length: 30 }).replace(
    /(\r\n|\n|\r)/gm,
    ""
  );
  version.displayName = `${commitDateStr} | ${packageName}[${hashShort}] | ${author} | git[${gitShaShort}] | [${gitBranch}] ${gitMessage}`;

  return version;
};

const determineVersionToRelease = (
  cmdObj,
  bucketNames,
  environment,
  bucketPath,
  packageName
) => {
  // noinspection JSUnresolvedVariable
  const bucketName = _.get(bucketNames, environment.serverEnvironment);
  if (!bucketName) {
    // noinspection JSUnresolvedVariable
    console.error(
      `The server environment ${environment.serverEnvironment} does not exist.`
    );
    process.exit(1);
  }

  return getDeployedVersionList(bucketName, bucketPath)
    .then((versions) => {
      return formatAndLimitDeployedVersions(versions, 20); // Only show last 20 versions
    })
    .then((versions) => {
      return Promise.all(versions.map((version) => addGitSha(version)));
    })
    .then((versions) => {
      return Promise.all(
        versions.map((version) => addGitInfo(version, packageName))
      );
    })
    .then((versions) => {
      if (versions.length === 0) {
        console.log(
          "\n> There are no currently deployed versions. Run 'gurgler configure <gitCommitSha> <gitBranch>' and `gurgler deploy` and try again.\n"
        );
        process.exit(0);
      }
      if (_.isEmpty(cmdObj.commit)) {
        return inquirer.prompt([
          {
            type: "list",
            name: "version",
            message: "Which deployed version would you like to release?",
            choices: versions.map((version) => {
              return { name: version.displayName, value: version };
            }),
          },
        ]);
      } else {
        return new Promise((resolve) => {
          if (cmdObj.commit.length < 7) {
            console.error(
              `The checksum "${cmdObj.commit}" is not long enough, it should be at least 7 characters.`
            );
            process.exit(1);
          }

          const version = _.find(versions, (version) => {
            return _.startsWith(version.gitSha, cmdObj.commit);
          });

          // TODO If we do not find it in this list of assets, check older assets too.

          if (!version) {
            console.error(
              `"${cmdObj.commit}" does not appear to be a valid checksum.`
            );
            process.exit(1);
          }

          resolve({ version: version });
        });
      }
    });
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
    const slackMessage = [
      `*${userDoingDeploy}* successfully released a new ${packageName} version to *${environment.key}*`,
      `_${version.displayName}_`,
      `<${slackConfig.githubRepoUrl}/commit/${version.gitSha}|View commit on GitHub>`,
    ].join("\n");

    // noinspection JSUnresolvedVariable
    const slackChannel = environment.slackChannel;

    if (!_.isEmpty(slackConfig.slackWebHookUrl) && !_.isEmpty(slackChannel)) {
      const webhook = new IncomingWebhook(slackConfig.slackWebHookUrl);

      (async () => {
        await webhook.send({
          username: slackConfig.slackUsername,
          text: slackMessage,
          icon_emoji: slackConfig.slackIconEmoji,
          channel: slackChannel,
        });
      })().catch((err) => console.error(err));
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

const release = async (
  environment,
  version,
  lambdaFunctions,
  packageName,
  slackConfig
) => {
  if (!_.has(environment, "serverEnvironment")) {
    throw new Error(
      `The server environment for this environment is not set: ${environment.key}`
    );
  }

  // noinspection JSUnresolvedVariable
  if (!_.has(lambdaFunctions, environment.serverEnvironment)) {
    // noinspection JSUnresolvedVariable
    throw new Error(
      `the lambda function for the following environment is not set: ${environment.serverEnvironment}`
    );
  }

  // noinspection JSUnresolvedVariable
  const functionName = lambdaFunctions[environment.serverEnvironment];

  const client = new LambdaClient();
  const input = {
    FunctionName: functionName,
    InvocationType: "RequestResponse",
    Payload: JSON.stringify({
      parameterName: environment.ssmKey,
      parameterValue: version.hash,
    }),
  };
  const command = new InvokeCommand(input);
  const response = await client.send(command);

  if (response.StatusCode !== 200) {
    throw new Error(
      `unsuccessful lambda invocation; unable to release asset version; got status ${response.StatusCode}`
    );
  }
  if (response.FunctionError) {
    throw new Error(
      `one or more parameter store values could not be updated: ${response.Payload}`
    );
  }
  sendReleaseMessage(environment, version, packageName, slackConfig);
};

const confirmRelease = (environment, version, packageName) => {
  return inquirer
    .prompt([
      {
        type: "confirm",
        name: "confirmation",
        message: `Do you want to release ${packageName} git[${version.gitShaDigest}] hash[${version.hashDigest}] to ${environment.key}?`,
        default: false,
      },
    ])
    .then((answers) => {
      // noinspection JSUnresolvedVariable
      if (
        answers.confirmation &&
        environment.masterOnly &&
        version.gitBranch !== "master"
      ) {
        // noinspection JSUnresolvedVariable
        return inquirer.prompt([
          {
            type: "confirm",
            name: "confirmation",
            message: `Warning: You are attempting to release a non-master branch[${version.gitBranch}] to a master-only environment[${environment.serverEnvironment}]. Do you wish to proceed?`,
          },
        ]);
      }
      return answers;
    });
};

const configureCmd = (gurglerPath, bucketPath, commit, branch) => {
  const hash = createHash("sha256");
  const raw = `${commit}|${branch}`;

  hash.update(raw);
  const hashed = hash.digest("hex");
  const prefix = bucketPath + "/" + hashed;

  const data = JSON.stringify(
    {
      commit,
      branch,
      raw,
      hash: hashed,
      prefix,
    },
    null,
    2
  );

  writeFile(gurglerPath, data, (err) => {
    if (err) {
      throw err;
    }
    console.log(
      `gurgler successfully configured; the current build info can be found at ${gurglerPath}\n`
    );
  });
};

/**
 *
 * @param bucketNames
 * @param gurglerPath
 * @param globs
 * @param pretend {boolean}
 */
const deployCmd = async (bucketNames, gurglerPath, globs, pretend = false) => {
  console.log("deployCmd", bucketNames, gurglerPath, globs, pretend);

  const data = await readFile(gurglerPath);
  let localFilePaths = [gurglerPath];

  globs.forEach((aGlob) => {
    localFilePaths = localFilePaths.concat(
      glob.sync(aGlob.pattern, {
        ignore: aGlob.ignore,
      })
    );
  });

  const { prefix, raw } = JSON.parse(data);

  localFilePaths.forEach((localFilePath) => {
    readFileAndDeploy(bucketNames, prefix, localFilePath, raw, pretend);
  });
};

const releaseCmd = (
  cmdObj,
  bucketNames,
  lambdaFunctions,
  environments,
  bucketPath,
  packageName,
  slackConfig
) => {
  let environment;
  let version;

  requestCurrentlyReleasedVersions(environments)
    .then((environments) => {
      return determineEnvironment(cmdObj, environments);
    })
    .then((answers) => {
      environment = answers.environment;
      return determineVersionToRelease(
        cmdObj,
        bucketNames,
        environment,
        bucketPath,
        packageName
      );
    })
    .then((answers) => {
      version = answers.version;
      return confirmRelease(environment, version, packageName);
    })
    .then((answers) => {
      // noinspection JSUnresolvedVariable
      if (answers.confirmation) {
        release(
          environment,
          version,
          lambdaFunctions,
          packageName,
          slackConfig
        );
      } else {
        console.log("Cancelling release...");
      }
    })
    .catch((err) => console.error(err));
};

const cleanupCmd = async (
  cmdObj,
  bucketNames,
  lambdaFunctions,
  environments,
  bucketPath,
  packageName
) => {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 90);

  // This line might be too clever. It's getting all the server environments and then getting an array of just the unique ones.
  // noinspection JSUnresolvedVariable
  const serverEnvironments = [
    ...new Set(
      environments.map((environment) => environment.serverEnvironment)
    ),
  ];

  const confirmationQuestions = serverEnvironments.map((serverEnvironment) => {
    const bucketName = _.get(bucketNames, serverEnvironment);
    return {
      type: "confirm",
      name: serverEnvironment,
      message: `Do you want to clean up the gurgler assets in the S3 bucket ${bucketName} with the path: ${bucketPath}?`,
      default: false,
    };
  });

  inquirer.prompt(confirmationQuestions).then((answers) => {
    serverEnvironments.map((serverEnvironment) => {
      if (answers[serverEnvironment]) {
        const bucketName = _.get(bucketNames, serverEnvironment);
        console.log(
          `Cleaning up gurgler assets in the S3 bucket ${bucketName} with the path: ${bucketPath} `
        );

        requestCurrentlyReleasedVersions(environments)
          .then((releasedVersions) => {
            return getDeployedVersionListWithMetadata(
              bucketName,
              bucketPath,
              packageName
            ).then((deployedArtifacts) => {
              console.log(
                `There are currently a total of ${deployedArtifacts.length} deployed artifacts in ${serverEnvironment}.`
              );

              const oldArtifacts = deployedArtifacts
                .filter((artifact) => {
                  // only allow an asset to be deleted if it's older than a year
                  return (
                    artifact.lastModified.getTime() < ninetyDaysAgo.getTime()
                  );
                })
                .filter((artifact) => {
                  // only allow an asset to be deleted if it's not being used in any of the environments
                  for (const releasedVersion of releasedVersions) {
                    // noinspection JSUnresolvedVariable
                    if (releasedVersion.releasedHash === artifact.hash) {
                      return false;
                    }
                  }
                  return true;
                });
              console.log(
                `We are going to delete ${oldArtifacts.length} ${packageName} artifact(s) in ${serverEnvironment}`
              );

              return oldArtifacts;
            });
          })
          .then((artifactsToDelete) => {
            if (artifactsToDelete.length < 1) {
              console.log("Nothing to delete.");
            }

            for (const artifact of artifactsToDelete) {
              console.log(artifact.displayName);
            }
            inquirer
              .prompt({
                type: "confirm",
                name: "reallyDelete",
                message: `Really delete these assets in the S3 bucket ${bucketName} with the path: ${bucketPath}?`,
                default: false,
              })
              .then(async (answers) => {
                // noinspection JSUnresolvedVariable
                if (answers.reallyDelete) {
                  for (const artifact of artifactsToDelete) {
                    console.log("Deleting", artifact.hash);

                    const client = new S3Client();

                    await emptyS3Directory(
                      client,
                      bucketName,
                      artifact.directoryPath
                    );

                    const input = {
                      Bucket: bucketName,
                      Delete: {
                        Objects: [
                          {
                            Key: artifact.filepath,
                          },
                          {
                            Key: artifact.directoryPath,
                          },
                        ],
                      },
                    };

                    const command = new DeleteObjectsCommand(input);
                    await client.send(command);
                  }
                  console.log("Deleted.");
                } else {
                  console.log("Very well, not deleting anything then.");
                }
              });
          });
      }
    });
  });
};

export { configureCmd, deployCmd, releaseCmd, cleanupCmd };
