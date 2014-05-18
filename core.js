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

  function addClosedBy(issues, callback) {
    fetchEvents(function(err, events) {
      async.map(issues, setClosingIssue.bind(this, events), callback);
    });
  }

  function setClosingIssue(events, issue, mappedTo) {
    if (issue.pull_request.url) {
      process.nextTick(function() {
        mappedTo(null, issue);
      });
    } else {
      var issueClosedEvent, simultaneousClosedEvent;
      events.some(function(event) {
        if (event.event === "closed") {
          if (event.issue && event.issue.number == issue.number) {
            issueClosedEvent = event;
            return true;
          }
        }
      });

      events.some(function(event) {
        if (issueClosedEvent !== event) {
          if (event.event == "closed") {
            if (event.created_at === issueClosedEvent.created_at) {
              // I wish GitHub provided a more exact way to match
              // "this PR's body, which 'fixes #NN', closed that issue"
              simultaneousClosedEvent = event;
              return true;
            }
          }
        }
      });

      if (simultaneousClosedEvent) {
        issue.closed_by_issue = simultaneousClosedEvent.issue;
      }

      process.nextTick(function() {
        mappedTo(null, issue);
      });
    }
  }


  var events;
  function fetchEvents(callback) {
    if (events) {
      process.nextTick(function() { callback(null, events); });
      return;
    }

    var page = 1;
    var limit = 100;
    events = []
    function fetch() {
      var params = {
        user: owner,
        repo: options.repo,
        per_page: limit,
        page: page
      };
      github.events.getFromRepoIssues(params, function(err, batch) {
        if (err) {
          return callback(err);
        }
        events = events.concat(batch);

        var done = false;
        if (batch.length < limit) {
          done = true;
        } else if (Date.parse(batch[batch.length - 1].created_at) < since) {
          done = true;
        }

        if (!done) {
          ++page;
          fetch();
        } else {
          callback(null, events);
        }
      });
    }
    fetch();
  }




  function filterMerged(issues, callback) {
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
    addClosedBy,
    filterMerged,
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
