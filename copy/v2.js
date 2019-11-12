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

const deployCmd = (gurglerPath, globs, localFilePaths) => {
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
      readFileAndDeploy(bucketNames, prefix, localFilePath, raw);
    });
  });
}

module.exports = {
  configureCmd,
  deployCmd
}
