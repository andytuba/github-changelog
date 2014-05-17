#!/usr/bin/env node

// core modules
var fs = require('fs');
var path = require('path');

// 3rd party modules
var Client = require('github');
var async = require('async');
var handlebars = require('handlebars');

module.exports.run = function(options) {
  if (!options.repo) {
    throw false;
  }
  if (!options.username && !options.owner) {
    throw 'One of "username" or "owner" options must be provided';
  }
  if (!(options.since || options.file)) {
    throw 'One of "since" or "file" options must be provided';
  }
  if (options.file && !fs.existsSync(options.file)) {
    throw 'File not found: %s', options.file;
  }

  var templatePath = options.template || path.join(__dirname, 'changelog.hbs');
  var template = fs.readFileSync(templatePath, 'utf8');
  var changelog = handlebars.compile(template, {noEscape: true});


  var since = options.since || fs.statSync(options.file).mtime.toISOString();
  var header = options.header || 'Changes since ' + since;
  var owner = options.owner || options.username;
  var labels = options.labels || '';

  var github = new Client({version: '3.0.0'});

  if (options.username && options.password) {
    github.authenticate({
      type: 'basic',
      username: options.username,
      password: options.password
    });
  }

  function fetchIssues(callback) {
    var page = 1;
    var limit = 100;
    var issues = [];
    function fetch() {
      var issuesParams = {
        user: owner,
        repo: options.repo,
        state: 'closed',
        sort: 'updated',
        labels: labels,
        since: since,
        per_page: limit,
        page: page
      };
      github.issues.repoIssues(issuesParams, function(err, batch) {
        if (err) {
          return callback(err);
        }
        issues = issues.concat(batch);
        if (batch.length === limit) {
          ++page;
          fetch();
        } else {
          callback(null, issues);
        }
      });
    }
    fetch();
  }

  function filterIssues(issues, callback) {
    if (!options.merged) {
      process.nextTick(function() {
        callback(null, issues);
      });
    } else {
      async.filter(issues, function(issue, isMerged) {
        github.pullRequests.getMerged({
          user: owner,
          repo: options.repo,
          number: issue.number
        }, function(err, result) {
          isMerged(!err);
        });
      }, function(filtered) {
        callback(null, filtered);
      });
    }
  }

  function formatChangelog(issues, callback) {
    process.nextTick(function() {
      callback(null, changelog({
        header: header,
        issues: issues,
        owner: owner,
        repo: options.repo
      }));
    });
  }

  function writeChangelog(text, callback) {
    if (options.file) {
      var existing;
      async.waterfall([
        function(next) {
          fs.readFile(options.file, next);
        }, function(data, next) {
          existing = data;
          fs.writeFile(options.file, text, next);
        }, function(next) {
          fs.appendFile(options.file, existing, next);
        }
      ], callback);
    } else {
      process.nextTick(function() {
        console.log(text);
        callback(null);
      });
    }
  }

  async.waterfall([
    fetchIssues,
    filterIssues,
    formatChangelog,
    writeChangelog,
    options.done || function() { }
  ], function(err) {
    if (err) {
      console.error(err.message);
      process.exit(1);
    } else {
      process.exit(0);
    }
  });

};
