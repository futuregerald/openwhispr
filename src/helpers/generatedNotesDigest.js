const crypto = require("crypto");

function digestGeneratedNotes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = { digestGeneratedNotes };
