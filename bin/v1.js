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

const deployCmd = (bucketNames, bucketPath, gurglerPath, globs, localFilePaths) => {
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

    const { commit, branch } = JSON.parse(data)

    localFilePaths.forEach(localFilePath => {
      readFileAndDeploy(bucketNames, bucketPath, localFilePath, commit, branch);
    });
  });
}

module.exports = {
  deployCmd,
}
