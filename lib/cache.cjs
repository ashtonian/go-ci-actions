'use strict';
const fs = require('node:fs');
const path = require('node:path');
function walk(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const item of fs.readdirSync(root, {withFileTypes: true})) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) walk(file, visit);
    else if (item.isFile()) {
      try { visit(file, fs.lstatSync(file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
function measure(root) {
  const result = {bytes: 0, files: 0};
  walk(root, (_file, stat) => { result.bytes += stat.size; result.files++; });
  return result;
}
function trim(root, cutoff) {
  const result = {bytes: 0, files: 0, removedBytes: 0, removedFiles: 0};
  walk(root, (file, stat) => {
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(file);
      result.removedBytes += stat.size;
      result.removedFiles++;
    } else { result.bytes += stat.size; result.files++; }
  });
  return result;
}
module.exports = {measure, trim};
