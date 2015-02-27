/*
 * grunt-external-daemon
 * https://github.com/jlindsey/grunt-external-daemon
 *
 * Copyright (c) 2013 Joshua Lindsey
 * Licensed under the MIT license.
 */

 'use strict';

 module.exports = function(grunt) {

  var path  = require('path'),
      fs    = require('fs'),
      util  = require('util'),
      _     = require('underscore'),
      Tail  = require('tail').Tail,
      shelljs = require('shelljs'),
      treekill = require('tree-kill'),
      daemons = {};

  grunt.registerMultiTask('external_daemon', 'Launch external long-running background processes', function ( arg1 ) {
    var done = this.async();
    var options = this.options({
      verbose: !!grunt.option('verbose'),
      nodeSpawnOptions: {},
      startCheck: function() { return true; },
      startCheckInterval: 0.5,
      startCheckTimeout: 3.0,
      killSignal: 'SIGTERM'
    });
    var name = this.target;
    var cmd = this.data.cmd;
    var args = this.data.args || [];
    var stopCmd = this.data.stopCmd;
    var stopArgs = this.data.stopArgs;
    var startedEventName = 'external:'+this.target+':started';
    var stoppedEventName = 'external:'+this.target+':stopped';
    var eventName;
    var checkIntervalTime = (options.startCheckInterval * 1000),
        failTimeoutTime   = (options.startCheckTimeout * 1000);
    var logFunc = (options.verbose) ? grunt.log.write : grunt.verbose.write;
    var proc, daemon, tail, failTimeoutHandle, checkIntervalHandle,
        stopping = false, stdout = [], stderr = [];
    var handleSig = function () {
      daemon = daemons[name];

      if (!daemon.stopped) {
        grunt.log.ok('Stopping ' + name);
        if (stopCmd) {
          shelljs.exec(stopCmd + ' ' + stopArgs.join(' '), { silent: !options.verbose });
        } else {
          treekill(proc.pid, options.killSignal);
        }
        grunt.log.ok('Stopped ' + name);
      }

      if (typeof done === 'function') {
        done();
      }
    };

    if ( arg1 === 'stop' ) {
      daemon = daemons[name];
      if (daemon.stopped) {
        done();
        return
      }
      grunt.log.ok('Stopping ' + name );
      if ( stopCmd ) {
        cmd = stopCmd;
        args = stopArgs;
        options.startCheck = options.stopCheck;
        stopping = true;
      } else {
        treekill(daemon.proc.pid, options.killSignal);
        grunt.log.ok('Stopped ' + name);
        daemon.stopped = true;
        done();
        return;
      }
    }

    eventName = stopping ? stoppedEventName : startedEventName;

    // Make sure we don't leave behind any dangling processes.
    process.on('exit', handleSig);
    process.on('SIGTERM', handleSig);
    process.on('SIGHUP', handleSig);
    process.on('SIGINT', handleSig);

    if (!cmd || cmd.length === 0) {
      grunt.fail.warn(util.format('You must specify "cmd" for task %s', name));
    }

    if (args && !_.isArray(args)) {
      grunt.fail.warn(util.format('You must specify "args" as an array for task %s', name));
    }

    if (!_.isFunction(options.startCheck)) {
      grunt.fail.warn(util.format('You must specify "startCheck" as a function for task %s', name));
    }

    cmd = path.normalize(grunt.template.process(cmd));
    args = _.map(args, function(arg) { return grunt.template.process(arg); });

    proc = grunt.util.spawn({
      cmd: cmd,
      args: args,
      opts: options.nodeSpawnOptions
    }, function (error, result, code) {
      // grunt.verbose.write(util.format("[%s STDOUT] %s\n"), cmd, result.stdout);
      // grunt.verbose.write(util.format("[%s STDERR] %s\n"), cmd, result.stderr);

      if (typeof options.stdout === 'number') {
        fs.closeSync(options.stdout);
      }
      if (typeof options.stderr === 'number' && options.stderr !== options.stdout) {
        fs.closeSync(options.stderr);
      }

      grunt.log.debug(util.format("Command %s exited with status code %s", cmd, code));
    });

    if (!stopping) {
      grunt.log.ok('Starting ' + name);
      daemons[name] = {
        proc: proc,
        stopped: false
      };
    }

    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');

    proc.stdout.on('data', function(data) {
      stdout.push(data);
      logFunc(util.format("[%s STDOUT] %s", cmd, data));

      if (typeof options.stdout === 'number') {
        var buf = new Buffer(data);
        fs.writeSync(options.stdout, buf, 0, buf.length);
      }
    });
    proc.stderr.on('data', function(data) {
      stderr.push(data);
      logFunc(util.format("[%s STDERR] %s", cmd, data));

      if (typeof options.stderr === 'number') {
        var buf = new Buffer(data);
        fs.writeSync(options.stderr, buf, 0, buf.length);
      }
    });

    if (options.logFile) {
      tail = new Tail(options.logFile, null, {}, false);
      tail.on('line', function(data) {
        stdout.push(data);
        logFunc(util.format("[%s LOG] %s\n", cmd, data));
      });
      grunt.event.on(eventName, function(targetName) {
        if (name == targetName) {
          tail.unwatch();
        }
      });
    }

    grunt.event.on(eventName, function() {
      clearTimeout(failTimeoutHandle);
      clearInterval(checkIntervalHandle);

      grunt.log.ok(util.format("%s %s", stopping ? 'Stopped' : 'Started', name));
      if (stopping) {
        daemons[name].stopped = true;
      }
      
      done();
    });

    // If timeout check is set to false instead of a number, disable the timeout.
    if (options.startCheckTimeout !== false) {
      failTimeoutHandle = setTimeout(function() {
        treekill(proc.pid, 'SIGHUP');
        clearInterval(checkIntervalHandle);
        grunt.fail.fatal(util.format("Command timed out: %s", cmd));
      }, failTimeoutTime);
    }

    // Start the check interval.
    checkIntervalHandle = setInterval(function() {
      if (options.startCheck(stdout.join(), stderr.join())) {
        grunt.event.emit(eventName, name);
      }
    }, checkIntervalTime);
  });
 };
