/**
 * This file is part of dHealth Wallet Plugins shared under LGPL-3.0
 * Copyright (C) 2021 Using Blockchain Ltd, Reg No.: 12658136, United Kingdom
 *
 * @package     dHealth Wallet Plugins
 * @subpackage  Health to Earn with Strava
 * @author      Grégory Saive for Using Blockchain Ltd <greg@ubc.digital>
 * @license     LGPL-3.0
 */
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as moment from 'moment';
import axios from 'axios';
import { Address } from '@dhealth/sdk';

// /!\ CAUTION /!\ 
// /!\ reads service account
// /!\ never checkin this file into a repository.
const serviceAccount = require('../.firebaseAuth.json');

// initializes firebase/firestore
admin.initializeApp({
  projectId: 'health-to-earn',
  credential: admin.credential.cert(serviceAccount),
});

// shortcuts
const DATABASE = admin.firestore();

/// region cloud functions
/**
 * @function  authorize
 * @link      /health-to-earn/us-central1/authorize
 *
 * Step 1 of the dHealth <> Strava link process.
 *
 * This request handler handles the authorization of
 * an app in Strava (OAuth).
 *
 * @see https://developers.strava.com/docs/authentication/#requesting-access
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
export const authorize = functions.https.onRequest((request: any, response: any) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /authorize request with query: ", request.query);

  // param `dhealth.address` is obligatory
  const data = request.query;
  if (!('dhealth.address' in data)) {
    return response.sendStatus(400);
  }

  // parses address to validate content or bail out
  try { Address.createFromRawAddress(data['dhealth.address']) }
  catch (e) { return response.sendStatus(400); }

  // reads environment configuration
  const stravaConf = functions.config().strava;

  // builds the strava OAuth query
  const stravaQuery = `?`
    + `client_id=${stravaConf.client_id}`
    + `&response_type=code`
    + `&approval_prompt=auto`
    + `&scope=activity:read`
    + `&redirect_uri=${encodeURIComponent(stravaConf.oauth_url)}` // should be /link
    + `&state=${data['dhealth.address']}`; // forwards address

  return response.redirect(301,
    'https://www.strava.com/oauth/authorize' + stravaQuery
  );
});

/**
 * @function  link
 * @link      /health-to-earn/us-central1/link
 *
 * Step 2 of the dHealth <> Strava link process.
 *
 * This request handler handles the callback of an
 * authorization of an app in Strava (Token Exchange).
 *
 * @see https://developers.strava.com/docs/authentication/#token-exchange
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
export const link = functions.https.onRequest((request: any, response: any) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /link request with query: ", request.query);

  // reads request query (GET)
  const data = request.query;

  if ('error' in data && data['error'] === 'access_denied') {
    // traces failures for monitoring
    functions.logger.warn("[WARN] User denied access to app: ", request);
    return response.sendStatus(403);
  }

  if (! ('code' in data) || ! ('scope' in data) || ! ('state' in data)) {
    // malformed link request
    return response.sendStatus(400);
  }

  // parses address to validate content or bail out
  const dhpAddress = data['state'];
  try { Address.createFromRawAddress(dhpAddress) }
  catch (e) { return response.sendStatus(400); }

  const stravaConf = functions.config().strava;
  const stravaCode = data['code'];
  axios.post('https://www.strava.com/oauth/token', {
    client_id: stravaConf.client_id,
    client_secret: stravaConf.client_secret,
    code: stravaCode,
    grant_type: 'authorization_code'
  })
  .then((res: any) => {
    const athlete = res.data.athlete;
    const address = dhpAddress;

    // saves the user in database
    DATABASE.collection('users').doc('' + athlete.id).set({
      address,
      athleteId: athlete.id,
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      accessExpiresAt: res.data.expires_at,
      linkedAt: new Date().valueOf(),
    }, { merge: true })
    .then((user: any) => {

      //XXX display basic index.html with Thank you message

      // ends the link process
      return response.sendStatus(200);
    })
    .catch((reason: any) => {
      // traces errors for monitoring
      functions.logger.error("[ERROR] Error happened with Firestore saving users entry: ", reason);
      return response.sendStatus(500);
    });
  })
  .catch((reason: any) => {
    // traces errors for monitoring
    functions.logger.error("[ERROR] Error calling Strava /oauth/token: ", reason);
    return response.sendStatus(400);
  })
});

/**
 * @function  unlink
 * @link      /health-to-earn/us-central1/unlink
 *
 * Optional Step of the dHealth <> Strava link process.
 *
 * This request handler handles the callback of a
 * cancellation of link between a Strava account and
 * a dHealth address.
 *
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
export const unlink = functions.https.onRequest((request: any, response: any) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /unlink request with query: ", request.query);

  //XXX use refreshToken to get accessToken
  //XXX use accessToken to GET /athlete
  //XXX remove database `address` value

  return response.sendStatus(501);
});

/**
 * @function  webhook
 * @link      /health-to-earn/us-central1/webhook
 *
 * Step 4 of the dHealth <> Strava link process.
 *
 * This request handler handles the creation of a
 * webhook subscription for Strava and the follow
 * -up steps whenever an activity is created in a
 * Strava account linked to this app.
 *
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
export const webhook = functions.https.onRequest(async (request: any, response: any) => {
  // proxies over to correct request handler
  if (request.method === 'GET') {
    return webhookSubscriptionHandler(request, response);
  }
  else if (request.method === 'POST') {
    // @async event handler
    return await webhookEventHandler(request, response);
  }

  // bails out on invalid requests
  return response.sendStatus(403);
});

/**
 * @function  status
 * @link      /health-to-earn/us-central1/status
 *
 * Step 0 of the dHealth <> Strava link process.
 *
 * This request handler handles status  requests
 * to find out whether an account link should be
 * done or whether the link already exists.
 *
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
export const status = functions.https.onRequest((request: any, response: any) => {
  // proxies over to correct request handler
  if (request.method !== 'GET') {
    return response.sendStatus(403);
  }

  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /status request with query: ", request.query);

  // param `dhealth.address` is obligatory
  const data = request.query;
  if (!('dhealth.address' in data)) {
    return response.sendStatus(400);
  }

  // parses address to validate content or bail out
  try { Address.createFromRawAddress(data['dhealth.address']) }
  catch (e) { return response.sendStatus(400); }

  // finds user by address
  const users = DATABASE.collection('users');
  users.where('address', '==', data['dhealth.address'])
    .get()
    .then((user: any) => {
      if (user.exists) {
        // 200 - OK
        return response.sendStatus(200);
      }

      // 404 - Not Found
      return response.sendStatus(404);
    })
    .catch((reason: any) => {
      // traces errors for monitoring
      functions.logger.error("[ERROR] Error happened with Firestore: ", reason);
      return response.sendStatus(500);
    });
});

/**
 * @function  subscribe
 * @link      /health-to-earn/us-central1/subscribe
 *
 * One-time only Step of the dHealth <> Strava link process.
 *
 * This request handler handles the creation of a
 * webhook subscription for Strava. Afterwards, a
 * request from Strava will be issued using a GET
 * request to the /webhook cloud function.
 *
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
 export const subscribe = functions.https.onRequest((request, response) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /subscribe request");

  const stravaConf = functions.config().strava;
  axios.post('https://www.strava.com/api/v3/push_subscriptions', {
    client_id: stravaConf.client_id,
    client_secret: stravaConf.client_secret,
    callback_url: stravaConf.webhook_url,
    verify_token: stravaConf.verify_token,
  })
  .then((res) => {
    return response
      .status(200)
      .json(res.data);
  })
  .catch((reason) => {
    // traces errors for monitoring
    functions.logger.error("[ERROR] Error happened calling Strava /push_subscriptions: ", reason);
    return response.sendStatus(400);
  });
});

/**
 * @function  unsubscribe
 * @link      /health-to-earn/us-central1/unsubscribe
 *
 * Optional Step of the dHealth <> Strava link process.
 *
 * This request handler handles the callback of a
 * cancellation of subscription for Webhooks on a
 * Strava account.  The user will not receive any
 * more rewards after being unsubscribed.
 *
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {void}
 */
export const unsubscribe = functions.https.onRequest((request: any, response: any) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /unsubscribe request with query: ", request.query);
  return response.sendStatus(501);
});
/// end-region cloud functions

/// region cloud scheduler functions
/**
 * @function  payout
 * @link      /health-to-earn/us-central1/payout
 *
 * This request handler **schedules** a job to run
 * every 20 seconds.  The job checks whether there
 * are  any rewards to be paid out  and marks them 
 * as processed.
 *
 * Caution: This method **must not** be  run using
 * a different system than the cloud scheduler, ie.
 * do not allow the execution of this function with
 * HTTP endpoint calls.
 *
 * @async
 * @params    {Request}   request
 * @params    {Response}  response
 * @returns   {null|number}         Integer return marks error.
 */
export const payout = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
  // finds unprocessed rewards
  const snapshot: any = await DATABASE.collection('rewards')
    .where('isProcessed', '==', false)
    .get();

  // bails out on empty rewards list
  if (snapshot.empty) {
    return null;
  }

  functions.logger.log("[DEBUG] Found non-zero unprocessed rewards count: ", snapshot.length);
  //XXX proceed to payout
  return null;
});

/// end-region cloud scheduler functions

/// region private API
/**
 * Request handler for GET requests to the cloud function.
 *
 * This method verifies the format of the request payload
 * and returns a 200 success response with the challenge.
 *
 * @param   {Request}   request 
 * @param   {Response}  response 
 * @returns {Response}
 */
const webhookSubscriptionHandler = (request: any, response: any) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /webhook GET request with query: ", request.query);

  // reads request query (GET)
  const data = request.query;

  // params `hub.mode` and `hub.verify_token` are obligatory
  if (!('hub.mode' in data) || !('hub.verify_token' in data)) {
    return response.sendStatus(400);
  }

  // GET handles only subscriptions with correct verify token
  const verify_token = functions.config().strava.verify_token;
  if (data['hub.mode'] !== 'subscribe' || data['hub.verify_token'] !== verify_token) {
    // traces failures for monitoring (malicious request attempts)
    functions.logger.warn("[WARN] Identified malicious request attempt: ", request);
    return response.sendStatus(401);
  }

  // SUCCESS, returns challenge
  return response
    .status(200)
    .json({'hub.challenge': data['hub.challenge']});
};

/**
 * Request handler for POST requests to the cloud function.
 *
 * This method handles incoming Strava activities and other
 * events pushed by Strava on the webhook subscription.
 *
 * @async
 * @param   {Request}   request 
 * @param   {Response}  response 
 * @returns {Response}
 */
const webhookEventHandler = async (request: any, response: any) => {
  // traces calls for monitoring
  functions.logger.log("[DEBUG] Now handling /webhook POST request with body: ", request.body);

  // reads request body (POST - should be JSON)
  const data = request.body;

  // validates presence of obligatory parameters
  if (! ('object_type' in data) || ! ('object_id' in data)
   || ! ('aspect_type' in data) || ! ('owner_id' in data)) {
    return response.sendStatus(400);
  }

  // webhook should handle only NEW ACTIVITIES
  if (data['object_type'] !== 'activity' || data['aspect_type'] !== 'create') {
    return response.status(200).send('EVENT_IGNORED');
  }

  // ------
  // Step 0: The webhook handler is **tried**
  try {

    // ------
    // Step 1: searches the user by it's Strava id
    const user: any = await DATABASE.doc(`users/${data['owner_id']}`).get();

    // bails out for unknown users
    if (! user.exists) {
      return response.status(200).send('EVENT_IGNORED');
    }

    // prepares rewards entry
    const rewardedDate = new Date();
    const formattedDate = moment(rewardedDate).format('YYYYMMDD');
    const address = user.data().address;
    const athleteId = user.data().athleteId;
    const activityId = data['object_id']; // from Strava

    // index uses date-only and athlete id (one per day).
    // e.g. "20211103-94380856"
    const rewardsId = `${formattedDate}-${athleteId}`;

    // ------
    // Step 2: checks if there is already a rewards entry for today
    const reward: any = await DATABASE.doc(`rewards/${rewardsId}`).get();

    // bails out given existing rewards entry
    if (reward.exists) {
      return response.status(200).send('EVENT_IGNORED');
    }

    // ------
    // Step 3: saves `rewards` entry (unprocessed / incomplete)
    await DATABASE.collection('rewards').doc(rewardsId).set({
      address,
      athleteId,
      activityId,
      isProcessed: false,
      isConfirmed: false,
      rewardDay: formattedDate,
      activityAt: moment(rewardedDate).format('YYYY-MM-DD HH:mm:ss Z'),
    }, { merge: true });

    // Job Successful
    return response.status(200).send('EVENT_RECEIVED');
  }
  catch (reason) {
    functions.logger.error("[ERROR] Error happened with /POST webhook handler: ", ('' + reason));

    // Webhook response **must be** 200 (risk of ban @Strava)
    return response.status(200).send('EVENT_IGNORED');
  }
};
/// end-region private API
