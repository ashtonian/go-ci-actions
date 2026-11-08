'use strict';
const {spawnSync} = require('node:child_process');
const path = require('node:path');
module.exports = function run(command) {
let result;
for (const python of ['python3', 'python']) {
  result = spawnSync(python, [path.join(__dirname, 'artifact.py'), command], {
    stdio: 'inherit', timeout: 15 * 60 * 1000, killSignal: 'SIGTERM',
    env: Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.startsWith('INPUT_') ? key.replaceAll('-', '_') : key, value])),
  });
  if (result.error?.code !== 'ENOENT') break;
}
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
};
