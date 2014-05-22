#!/usr/bin/env node

// core modules
var fs = require('fs');
var path = require('path');

// 3rd party modules
var Client = require('github');
var async = require('async');
var handlebars = require('handlebars');

var options;
var since;
var owner;
var github;
var header;
var labels;

module.exports.run = function(_options) {
  options = _options;
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
  changelog = handlebars.compile(template, {noEscape: true});


  since = options.since || fs.statSync(options.file).mtime.toISOString();
  header = options.header || 'Changes since ' + since;
  owner = options.owner = (options.owner || options.username);
  labels = options.labels || '';

  github = new Client({version: '3.0.0'});

  if (options.username && options.password) {
    github.authenticate({
      type: 'basic',
      username: options.username,
      password: options.password
    });
  }

  async.waterfall([
    fetchIssues,
    logIssues.bind(this, "fetchIssues"),
    addClosedBy,
    logIssues.bind(this, "addClosedBy"),
    filterFixed,
    logIssues.bind(this, "filterFixed"),
    /*  */
    function (callback) {
      // Log issues
//      console.log("checkpoint!");
      var args = [].slice.call(arguments, 0, arguments.length - 1);
      var callback = arguments[arguments.length - 1];

      args.unshift(null);
      callback.apply(this, args);
    },
  /*  */
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


function logIssues(after, issues, callback) {
  if (options.debug >= 3) {
    console.log("after", after, "issues.length=", issues.length);
  }
  if (options.debug >= 6) {
    var ids = issues.map(function(item) { return parseInt(item.number, 10); });
    ids.sort();
    console.log(ids.join(' '));
  }

  callback(null, issues);
}

///////////////////////////////////////



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

function setClosingIssue(events, issue, callback) {
  if (issue.pull_request.url) {
    process.nextTick(function() {
      callback(null, issue);
    });
  } else {
    var simultaneousClosedEvent;
    events.some(function(event) {
      if (event.event == "closed") {
        if (event.created_at === issue.closed_at && event.issue.id !== issue.id) {
          // I wish GitHub provided a more exact way to match
          // "this PR's body, which 'fixes #NN', closed that issue"
          simultaneousClosedEvent = event;
          return true;
        }
      }
    });

    if (simultaneousClosedEvent) {
      issue.closed_by_issue = simultaneousClosedEvent.issue;
    }

    process.nextTick(function() {
      callback(null, issue);
    });
  }
}


function filterMerged(issues, callback) {
  if (options.merged === false) {
    process.nextTick(function() {
      callback(null, issues);
    });
  } else {
    fetchEvents(function(err, events) {
      async.filter(issues, notUnmergedPR.bind(this, events), function(result) {
        callback(null, result);
      });
    });
  }
}

function notUnmergedPR(events, issue, callback) {
  if (!(issue.pull_request && issue.pull_request.url)) {
    process.nextTick(function() {
      callback(true);
    });
  } else {
    var mergedEvent;
    events.some(function(event) {
      if (event.event == "merged") {
        if (event.issue.id === issue.id) {
          mergedEvent = event;
          return true;
        }
      }
    });

    process.nextTick(function() {
      callback(!!mergedEvent);
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


//////////////////////////////////////////


var events;
var eventsSince;
var eventTypes = [ 'closed', 'merged' ];
var limit = 100;


function fetchEvents(callback) {
  if (events) { // already fetched
    process.nextTick(function() {
      callback(null, events);
    });
    return;
  }

  eventsSince = since || (Date.now() - (24*60*60*1000));

  async.waterfall([
    loadEventsFromFile,
    fetchEventsFromGithub.bind(this, 1),
    tidyUpEvents,
    storeEventsToFile,
    filterEventsByType,
    function(result) {
      // Stash in case fetchEvents is called again
      events = result;
      process.nextTick(function() {
        callback(null, result);
      });
    }
  ]);
}

function loadEventsFromFile(callback) {
  var events = [];
  if (options.events) {
    fs.readFile(options.events, "utf8" ,function(err, data) {
      if (!err) {
        try {
          var storedEvents = JSON.parse(data);
          if (storedEvents && storedEvents.length) {
            events = storedEvents;
            eventsSince = Date.parse(storedEvents[0].created_at);
          }
        } catch (e) {
          err = e;
        }

        callback(err, events);
      }
    });
  } else {
    process.nextTick(function() {
      callback(null, events);
    });
  }
}

function storeEventsToFile(events, callback) {
  var err = null;
  if (options.events) {
    fs.writeFile(options.events, JSON.stringify(events, null, 4), function(err) {
      /*
        if(err) {
          console.log(err);
        } else {
          console.log("Saved events", events.length, "to " + options.events);
        }
    */
        process.nextTick(function() {
          callback(err, events);
        });
    });
  }
}


function fetchEventsFromGithub(page, events, callback) {
  events = events || [];
  var params = {
    user: owner,
    repo: options.repo,
    per_page: limit,
    page: page
  };
  var since = events.length ? Date.parse(events[0].created_at)
             : options.since ? Date.parse(options.since)
             : Date.now();

  github.events.getFromRepoIssues(params, function(err, batch) {
    if (err) {
      return callback(err);
    }

    var done = false;
    if (batch.length < limit) {
      done = true;
    } else if (Date.parse(batch[batch.length - 1].created_at) < since) {
      done = true;

    // TODO: batch = [x for x not in events]
    }

    events = events.concat(batch);

    if (!done) {
      fetchEventsFromGithub(page+1, events, callback);
    } else {
      callback(null, events);
    }
  });
}

function tidyUpEvents(items, callback) {
  var indexedItems = {};

  for (var i = 0, length = items.length; i < length; i++) {
    var item = items[i];
    var key = item.created_at + '_' + item.id;
    indexedItems[key] = item;
  }

  var keys = Object.keys(indexedItems);
  keys.sort().reverse();

  var filtered = [];
  for (var i = 0, length = keys.length; i < length; i++) {
    filtered[i] = indexedItems[keys[i]];
  }

  process.nextTick(function() {
    callback(null, filtered);
  });
}

function filterEventsByType(events, callback) {
  var filtered = events.filter(function(event) {
    return (eventTypes.indexOf(event.event) != -1);
  });

  process.nextTick(function() {
    callback(null, filtered);
  });
}




