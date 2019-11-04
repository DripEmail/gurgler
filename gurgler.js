const fs = require("fs");

const publicPath = () => {
  const data = fs.readFileSync("gurgler.json");
  return JSON.parse(data).publicPath;
}

module.exports.publicPath = publicPath;
