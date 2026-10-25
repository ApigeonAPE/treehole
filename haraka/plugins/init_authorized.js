// init_authorized.js - sync all authorized emails from the web server into Redis at startup
const redis = require('./shared/redis');
const { getWebServerConfig } = require('./shared/config');
const http = require('http');

exports.register = function () {
  var plugin = this;

  // delay until startup completes so it does not block
  setTimeout(function () {
    var cfg = getWebServerConfig();
    var url = 'http://' + cfg.internal_host + ':' + cfg.internal_port + '/api/internal/authorized-emails';

    plugin.loginfo('[init] Syncing authorized emails...');

    var req = http.get(url, { headers: { 'X-Internal-Token': cfg.internal_token } }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try {
          var json = JSON.parse(data);
          if (json.emails && json.emails.length > 0) {
            var client = redis.getClient();
            for (var i = 0; i < json.emails.length; i++) {
              client.sadd(redis.KEY_PREFIX.AUTHORIZED_EMAILS, json.emails[i]);
            }
            plugin.loginfo('[init] Synced ' + json.emails.length + ' authorized emails');
          } else {
            plugin.loginfo('[init] No authorized emails found');
          }
        } catch (e) {
          plugin.logerror('[init] Parse error: ' + e.message);
        }
      });
    });

    req.on('error', function (e) {
      plugin.logerror('[init] Sync failed: ' + e.message);
    });

    req.setTimeout(10000, function () {
      req.destroy();
      plugin.logerror('[init] Sync timeout');
    });
  }, 2000);
};
