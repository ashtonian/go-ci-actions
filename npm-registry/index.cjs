'use strict';
const {exportVariable, input, npmRegistry, output} = require('../lib/policy.cjs');
async function main() {
  const registry = await npmRegistry(input('mode') || 'auto', process.env);
  for (const notice of registry.notices) console.log('::notice::' + notice);
  for (const [name, value] of Object.entries(registry.env)) exportVariable(name, value);
  output('registry', registry.url);
  console.log('npm registry: ' + (registry.url || 'as configured by the job'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
