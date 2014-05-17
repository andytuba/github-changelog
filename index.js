#!/usr/bin/env node
var core = require('./core.js');
var program = require('commander');

program
    .option('-o, --owner <name>', 'Repository owner name.  If not provided, ' +
        'the "username" option will be used.')
    .option('-r, --repo <repo>', 'Repository name (required).')
    .option('-u, --username <name>', 'Your GitHub username (only required ' +
        'for private repos).')
    .option('-p, --password <pass>', 'Your GitHub password (only required ' +
        'for private repos).')
    .option('-f, --file <filename>', 'Output file.  If the file exists, ' +
        'log will be prepended to it.  Default is to write to stdout.')
    .option('-s, --since <iso-date>', 'Last changelog date.  If the "file" ' +
        'option is used and "since" is not provided, the mtime of the output ' +
        'file will be used.')
    .option('-m, --merged', 'List merged pull requests only.')
    .option('-e, --header <header>', 'Header text.  Default is "Changes ' +
        'since <since>".')
    .option('-t, --template <path>', 'Handlebar template to format data.' +
        'The default bundled template generates a list of issues in Markdown')
    .parse(process.argv);

try {
  core.run(program);
} catch (e) {
  if (e) {
    console.error('\n', e);
    program.help();
    process.exit(1);
  }
}
