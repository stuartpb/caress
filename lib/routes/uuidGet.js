var script = require('../redis-scripts/uuidGet.js');
var crypto = require('crypto');
function sha1hex(item) {
  return crypto.createHash('sha1').update(item).digest('hex');
}

module.exports = function(db, subscriber, pollWait, itemTTL) {
  return function uuidGet(req, res, topnext) {
    var id = req.params.path;

    // The index of the message to get / await. Listen for 0 (the initial /
    // root message) if not specified.
    var getIndex = req.params.index || 0;

    // The Etag of the body as it currently exists on the client
    var theirEtag = req.headers["if-none-match"];

    // The Etag of the body as it currently exists on the server
    // (will be set in the database callback)
    var ourEtag;

    // Timeout ID for responses
    var timer;

    // Clean up timer / subscription, then call the callback (respond).
    function finish(cb) {
      clearTimeout(timer);
      timer = null;
      return subscriber.unsubscribe(
        'message/' + id + '/' + getIndex, cb);
    }

    // Override the next() error/passthrough handler to clean up before
    // leaving. This way, the timer doesn't go off / the subscriber doesn't
    // handle messages after we've sent the response, and the server doesn't
    // crash as a result.
    function next(err) {
      return finish(function (finishErr) {
        if (err) return topnext(err);
        else if (finishErr) return topnext(finishErr);
        else return topnext();
      });
    }

    // Callback for if there's no new body by the time we're supposed to
    // respond.
    function noNew() {
      return finish(function(err) {
        if (err) return next(err);

        // If there was a body initially, respond that there's been no change
        if (ourEtag) return res.send(304);

        // Otherwise, respond that there's no content (yet)
        else return res.send(204);
      });
    }

    function respondNotFound() {
      return finish(function (err) {
        if(err) return next(err);

        return res.send(404);
      });
    }

    function sendNewEtagAndBody(body){
      return finish(function (err) {
        if(err) return next(err);

        return res.header('Etag',ourEtag).send(body);
      });
    }

    // Callback for when we get a mesage that there's a new body.
    function getNew(body) {
      // If we haven't already cleared the callback (we got the body, then the
      // message on the subscriber)
      if (timer) {
        // If the new body is present (say, if it wasn't deleted)
        if (body) {
          // Calculate the new Etag
          ourEtag = '"' + sha1hex(body) + '"';

          // If it's a new body (which it almost certainly should be)
          if (ourEtag != theirEtag) {
            sendNewEtagAndBody(body);
          }
          // If it's not a new body we do nothing and keep listening / waiting

        // If the new body is empty
        } else {
          // Respond that it is now Not Found
          respondNotFound();
        }
      }
    }

    // Subscribe to updates to the content we're listening to from the
    // other end
    subscriber.subscribe('message/' + id + '/' + getIndex, getNew);

    // Set a timer to respond if there's no new content over the duration
    // of the poll
    timer = setTimeout(noNew, pollWait);

    db.eval(script, 0, id, getIndex, itemTTL,
      function (err, results) {
        if (err) return next(err);

        // if we haven't already replied (ie. if the subscriber received a
        // message already)
        if (timer) {

          // Any body present in the message list at this index.
          var body = results[0];

          // Whatever TTL remains on the message-list, or a negative value
          // if there is no list.
          var listTtl = results[1];

          // 1 if this is a waiting offer/start or 0 otherwise.
          var offerWaiting = results[2];

          // If there's content for this route, or we're waiting for content
          if (listTtl > -1 || offerWaiting) {

            // If we have this content, calculate the etag for it
            if (body) ourEtag = '"' + sha1hex(body) + '"';

            // If we have content and it's not what the client already has
            if (body && ourEtag != theirEtag) {

              // Give it to them
              sendNewEtagAndBody(body);

            // If we don't have new content to offer, we wait for the
            // subscription or timeout to reply
            }

          // If there's no content for this route
          } else {

            // It is, as far as Get requests are concerned, Not Found
            respondNotFound();
          }
        }
      }
    );
  };
};
