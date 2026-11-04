const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FOLDERS = ['backend/src', 'backend/database', 'backend/scripts', 'frontend/js', 'tests'];

const files = FOLDERS.flatMap(folder =>
  fs.readdirSync(path.join(ROOT, folder), { recursive: true })
    .map(file => path.join(folder, String(file)))
    .filter(file => file.endsWith('.js'))
);

const failures = files.filter(file => spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'inherit' }).status !== 0);

console.log(failures.length ? `\n${failures.length} arquivo(s) com erro de sintaxe.` : `${files.length} arquivos conferidos, nenhum erro de sintaxe.`);
process.exit(failures.length ? 1 : 0);
