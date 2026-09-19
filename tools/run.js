const { execFileSync } = require('child_process');
const path = require('path');
function run(f) {
  try { execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' }); }
  catch (e) { console.error('\n[update] ' + f + ' failed. data.json was left untouched.'); process.exit(1); }
}
run('scrape.js'); run('build.js');
