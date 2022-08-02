const {exec} = require('child_process');

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitAuthor = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%aN' --no-patch ${gitSha}`, (err, stdout) => {
      if (err) {
        if (err.message.includes("unknown revision or path not in the working tree")) {
          reject(new Error(`Unknown commit hash when trying to look up the author: ${gitSha}`));
        } else {
          reject(err);
        }
      }
      resolve(stdout.trim());
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getBranch = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git rev-parse --abbrev-ref ${gitSha}`, (err, stdout) => {
      if (err) {
        if (err.message.includes("unknown revision or path not in the working tree")) {
          reject(new Error(`Unknown commit hash when trying to look up the branch: ${gitSha}`));
        } else {
          reject(err);
        }
      }
      resolve(stdout.trim());
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitMessage = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%s' --no-patch ${gitSha}`, (err, stdout) => {
      if (err) {
        if (err.message.includes("unknown revision or path not in the working tree")) {
          reject(new Error(`Unknown commit hash when trying to look the commit message: ${gitSha}`));
        } else {
          reject(err);
        }
      }
      resolve(stdout.trim());
    })
  })
}

/**
 * @param gitSha
 * @returns {Promise<string>}
 */
const getCommitDate = (gitSha) => {
  return new Promise((resolve, reject) => {
    exec(`git show --pretty='%ah' --no-patch ${gitSha}`, (err, stdout, stderr) => {
      if (err) {
        if (err.message.includes("unknown revision or path not in the working tree")) {
          reject(new Error(`Unknown commit hash when trying to look up the date of the commit: ${gitSha}`));
        } else {
          reject(err);
        }
      }
      if (stderr) {
        console.error(`exec error getCommitDate: ${stderr}`);
      }
      resolve(stdout.trim());
    })
  })
}

/**
 *
 * @param gitSha {string}
 * @returns {Promise<Map<string, string>>}
 */
const getGitInfo = async (gitSha) => {
  return await Promise.allSettled(
    [getCommitAuthor(gitSha),
      getBranch(gitSha),
      getCommitMessage(gitSha),
      getCommitDate(gitSha)
    ]).then(values => {
      const gitInfo = new Map();

      if (values.some(v => v.status === "rejected")) {
        gitInfo.set("gitSha", gitSha);
        gitInfo.set("author", "????");
        gitInfo.set("branch", "????");
        gitInfo.set("message", "????");
        gitInfo.set("date", "????");

        return gitInfo;
      } else  {
        const [authorResult, branchResult, messageResult, dateResult] = values;
        gitInfo.set("gitSha", gitSha);
        gitInfo.set("author", authorResult.value);
        gitInfo.set("branch", branchResult.value);
        gitInfo.set("message", messageResult.value);
        gitInfo.set("date", dateResult.value);

        return gitInfo;
      }
    });
}

module.exports = {
  getGitInfo
};
