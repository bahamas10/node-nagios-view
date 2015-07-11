#!/usr/bin/env node
/**
 * a simple CLI doshboard for nagios using the status.dat file
 *
 * Author: Dave Eddy <dave@daveeddy.com>
 * Date: May 29, 2015
 * License: MIT
 */

var fs = require('fs');

var c = require('cli-color');
var clear = require('clear');
var extsprintf = require('extsprintf');
var parse = require('nagios-status-parser');
var getopt = require('posix-getopt');
var human = require('human-time');

var printf = extsprintf.printf;
var sprintf = extsprintf.sprintf;

var package = require('./package.json');

// CLI options & usage
var opts = {
  color: process.stdout.isTTY,
  file: '/var/spool/nagios/status.dat',
  header: true,
  hideacknowledged: false,
  hostsonly: false,
  problems: false,
  servicesonly: false,
  status: true,
  statusonly: false,
  times: 'problems',
  watch: false,
};

var usage = [
  'usage: nagios-view [-hHnpsw] [-f /path/to/status.dat]',
  '',
  '  -f, --file <file>         supply the path to status.dat as <file>, defaults to ' + opts.file,
  '  -h, --help                print this message and exit',
  '  -u, --updates             check for available updates',
  '  -v, --version             print the version number and exit',
  '',
  '  -p, --problems            only show problem services (not OK status)',
  '  -w, --watch               update automatically every 10 seconds indefinitely',
  '      --hide-acknowledged   hide any services that have been acknowledged',
  '      --status-only         only print the status lines at the bottom with totals',
  '      --no-header           don\'t print header line at the top of the output',
  '      --no-status           don\'t print status lines at the bottom with totals',
  '      --hosts-only          only print hosts, not services',
  '      --services-only       only print services, not hosts',
  '',
  '  color output - defaults to color output if stdout is a TTY',
  '      --color               force color output',
  '      --no-color            disable color output',
  '',
  '  state change times - printed by default for only problem services or hosts',
  '      --times               print the time since last state change for all services and hosts',
  '      --no-times            don\'t print the time since last state change for anything',
].join('\n');

var options = [
  '1(hosts-only)',
  '2(no-header)',
  '3(no-status)',
  '4(color)',
  '5(no-color)',
  '6(services-only)',
  '7(no-times)',
  '8(times)',
  '9(status-only)',
  'f:(file)',
  'H(hide-acknowledged)',
  'h(help)',
  'p(problems)',
  'u(updates)',
  'w(watch)',
  'v(version)',
].join('');
var parser = new getopt.BasicParser(options, process.argv);

var option;
while ((option = parser.getopt())) {
  switch (option.option) {
    case '1': opts.hostsonly = true; break;
    case '2': opts.header = false; break;
    case '3': opts.status = false; break;
    case '4': opts.color = true; break;
    case '5': opts.color = false; break;
    case '6': opts.servicesonly = true; break;
    case '7': opts.times = 'none'; break;
    case '8': opts.times = 'all'; break;
    case '9': opts.statusonly = opts.status = true; break;
    case 'f': opts.file = option.optarg; break;
    case 'H': opts.hideacknowledged = true; break;
    case 'h': console.log(usage); process.exit(0);
    case 'p': opts.problems = true; break;
    case 'u': // check for updates
      require('latest').checkupdate(package, function(ret, msg) {
        console.log(msg);
        process.exit(ret);
      });
      return;
    case 'v': console.log(package.version); process.exit(0);
    case 'w': opts.watch = true; break;
    default: console.error(usage); process.exit(1);
  }
}
var filters = process.argv.slice(parser.optind());

// what to print based on nagios exit code
var service_marks = [
  c.green(' ✔ '),     // 0
  c.bgYellow(' ✘ '),  // 1
  c.bgRed(' ✘ '),     // 2
  c.bgMagenta(' ? '), // 3
];

var host_marks = [
  opts.hostsonly ? c.green('✔  ') : '', // 0
  c.yellow('✘  '),                      // 1
  c.red('✘  '),                         // 2
  c.magenta('?  '),                     // 3
];

// strip the color
if (!opts.color) {
  service_marks = service_marks.map(function(a) { return c.strip(a); });
  host_marks = host_marks.map(function(a) { return c.strip(a); });
}

// convert nagios exit code to string names
var codenames = [
  'ok',       // 0
  'warning',  // 1
  'critical', // 2
  'unknown',  // 3
];

// pad a string with another string
function pad(s, i, c) {
  s = s.toString();
  i = i || 0;
  c = c || ' ';
  while (s.length < i)
    s += c;
  return s;
}

// trim the right side of a string
function rtrim(s) {
  return s.replace(/\s+$/, '');
}

var longesthostname = 0;
// called at process start and optionally every 10 seconds
function go(initial) {
  // totals for --status
  var totals = {
    hosts: [ 0, 0, 0, 0 ],
    services: [ 0, 0, 0, 0 ],
  };
  var problems = 0;

  // read the status file
  var data;
  try {
    data = parse(fs.readFileSync(opts.file, 'utf8'));
  } catch (e) {
    if (initial) {
      console.error('failed to read %s: %s', opts.file, e.message);
      process.exit(1);
    }

    // print the error and keep watching
    console.error('[%s] failed to read %s: %s',
        new Date(),
        opts.file,
        e.message);
    return;
  }

  // construct a hosts object keyed by hostname
  var hosts = {};
  longesthostname = 0;
  data.hoststatus.forEach(function(host) {
    hosts[host.host_name] = host;
    longesthostname = Math.max(longesthostname, host.host_name.length);
  });

  // clear the screen if `-w` is supplied
  if (opts.watch) {
    clear(true);
    console.log('%s\n', new Date());
  }

  if (opts.header)
    console.log('Nagios View - %s - updated %s\n',
        opts.file,
        human(new Date(data.info[0].created * 1000)));

  // the current hostname being processed
  var hostname;

  // the hostname is lazily printed in the case that a service is not in OK
  // status, if the host is not in OK status, or if `-a` is supplied... this
  // variable acts as a boolean to determine if the hostname has been printed
  // yet
  var printed;

  // number of hosts printed
  var hostsprinted = 0;

  // loop each service
  data.servicestatus.forEach(function(service) {
    var host = hosts[service.host_name];

    // total problems
    if (service.current_state !== 0)
      problems++;

    // check filter (first operand)
    for (var i = 0; i < filters.length; i++) {
      var filter = filters[i];
      if (service.host_name.indexOf(filter) < 0 &&
          service.service_description.indexOf(filter) < 0)
        return;
    }

    // total the service state
    if (totals.services[service.current_state] !== undefined)
      totals.services[service.current_state]++;

    // check if its the first time seeing a host
    if (hostname !== service.host_name) {
      // total the host state
      if (totals.hosts[host.current_state] !== undefined)
        totals.hosts[host.current_state]++;

      // total problems
      if (host.current_state !== 0)
        problems++;

      hostname = service.host_name;
      printed = false;

      if (opts.statusonly)
        return;

      if (!opts.servicesonly &&
          (host.current_state !== 0 || (opts.hostsonly && !opts.problems))) {
        if (!opts.hostsonly && hostsprinted++ > 0)
          console.log();
        printhost(host);
        printed = true;
      }
    }

    // return if --hosts-only or --status-only is supplied
    if (opts.hostsonly || opts.statusonly)
      return;

    // only print the service if it is not OK, or if -p is not supplied
    if (!opts.problems || service.current_state !== 0) {

      // don't print if it has been acknowledged
      if (opts.hideacknowledged && service.problem_has_been_acknowledged)
        return;

      // print the hostname if this is the first time
      if (!opts.servicesonly && !printed) {
        if (hostsprinted++ > 0)
          console.log();
        printhost(host);
        printed = true;
      }

      // prit the service line and record the totals
      printservice(service);
    }
  });

  // print *something* if there were no problems
  if (opts.problems && problems === 0)
    console.log('(no problems)');

  if (opts.status) {
    if (!opts.statusonly)
      console.log();

    // loop "hosts" and "services"
    Object.keys(totals).forEach(function(key) {
      var total = totals[key];
      var counts = total.map(function(count, code) {
        return sprintf('%5d %s', count, codenames[code]);
      });

      // figure out what mark to print
      // the priority is critical, warning, unknown, and finally OK
      var code = 0;
      [2, 1, 3, 0].reverse().forEach(function(num) {
        if (total[num])
          code = num;
      });

      printf('%s %-10s %s\n', service_marks[code], key, counts.join(' '));
    });
  }
}

function printservice(service) {
  // output
  var output = service.plugin_output || '(no output)';
  if (!service.has_been_checked)
    output = '[PENDING CHECK]';

  // last time change
  var time = new Date(service.last_state_change * 1000);
  if (isFinite(time))
    time = human(time);
  else
    time = 'unknown';

  var s = sprintf('%s %-20s %-65s',
      service_marks[service.current_state] || ' ',
      service.service_description || '',
      output);

  if (opts.servicesonly)
    s = sprintf('%s %s', pad(service.host_name, longesthostname, ' '), s);

  if (opts.times === 'all' || (opts.times === 'problems' && service.current_state !== 0))
    s = sprintf('%s (%s)', s, time);

  if (service.problem_has_been_acknowledged)
    s = sprintf('%s [ACKNOWLEDGED]');

  console.log(rtrim(s));
}

function printhost(host) {
  var time = new Date(host.last_state_change * 1000);
  if (isFinite(time))
    time = human(time);
  else
    time = 'unknown';

  var s = sprintf('%s%-25s',
      host_marks[host.current_state] || '',
      host.host_name);

  if (opts.times === 'all' || (opts.times === 'problems' && host.current_state !== 0))
    s = sprintf('%s (%s)', s, time);

  if (host.problem_has_been_acknowledged)
    s = sprintf('%s [ACKNOWLEDGED]');

  console.log(rtrim(s));
}

// start
go(true);
if (opts.watch)
  setInterval(go, 10 * 1000);
