const shortHash = hash => hash.substring(0, 7);

const getContentType = (ext) => {
  let contentType = "application/octet-stream";
  // TODO: Add more content types
  if  (ext === ".css") {
    contentType = "text/css";
  } else if (ext === ".json") {
    contentType = "application/json"
  } else if (ext === ".html") {
    contentType = "text/html"
  } else if (ext ===  ".js") {
    contentType = "application/javascript"
  }
  return contentType;
}

module.exports = {
  shortHash,
  getContentType
}