/* jshint node: true, esversion: 6 */
"use strict";

import _ from 'lodash';
import Promise from 'bluebird';

import setupStorage from './storage/storage';
import {prepareConfig, prepareCallbacks} from './config';
import {createResultTransformer} from './steps/result-transformer';
import {createBeforeAfter} from "./steps/before-after-runner";
import {ChaplainTest} from './prototypes';
import {createOutputFetcher} from "./steps/fetch-from-source";
import {pluginTriggered} from "./utils";

export default function setupChaplain(suite, config) {
  // merge our configuration sources to get a final config
  config = prepareConfig(suite, config);

  // find the other plugins, but don't instantiate them yet
  // (they are instantiated per-test, not per-suite)
  const sourcePlugins = config.plugins.filter(p => p.plugin == 'source');
  const formatPlugins = config.plugins.filter(p => p.plugin == 'format');

  // create a few functions representing steps we take
  // TODO: more will come with refactor
  const transformResult = createResultTransformer(config);
  const fetcher = createOutputFetcher(config, suite);
  const beforeAfter = createBeforeAfter(suite);

  // initialize our blessed content storage
  const blessedStore = setupStorage(config);

  // returns a properly set-up chaplain object
  return {
    runSuite,
    blessSuite,
    blessTest
  };

  // =====================================================================

  function runSuite(callbacks) {
    callbacks = prepareCallbacks(callbacks);
    let context = {};
    let firstException;
    const {runBefores, runAfters} = beforeAfter;

    return runBefores()
      .then(() => performSetup(context))
      .then(() => runAllTests(testsToRun(suite), callbacks, context))
      .then(individualResults => ({
        results: individualResults,
        success: !_.some(individualResults, r => r.status != 'ok')
      }))
      .catch((err) => { firstException = err; throw err; }) // we always remember the first exception that happened
      .finally(() => performTeardown(context))
      .finally(() => runAfters())
      .finally(() => {
        // rethrow the first exception that happened - this will override any exceptions that happened
        // during running the other finally() clauses
        if (firstException)
          throw firstException;
      });
  }

  function blessSuite(callbacks) {
    callbacks = prepareCallbacks(callbacks);
    const tests = testsToRun(suite);

    return runSuite(callbacks)
      .then(({results}) => {
        return Promise.all(tests.map(t => {
          return blessTest(results[t.key()])
            .then(() => callbacks.testBlessed(t))
            .then(() => t.key());
        }));
      });
  }

  function runAllTests(tests, callbacks, context) {
    const resultPromises = tests.map(test => {
      callbacks.testStarted(test);

      return runTest(test, context)
        .then(result => {
          callbacks.testFinished(test, result);
          return [test.key(), result];
        }).catch(err => {
          if (err.code == 'EUSERFACING') {
            return [test.key(), {
              status: 'error',
              test,
              message: err.message
            }];
          } else {
            return [test.key(), {
              status: 'exception',
              test,
              exception: err,
              message: [
                err.message + "\n",
                (err.stack || err),
                "\n\nPlease report this issue here: ",
                {highlighted: "https://github.com/krajzeg/chaplain/issues"}
              ]
            }];
          }
        });
    });

    return Promise.all(resultPromises).then(_.fromPairs);
  }

  function runTest(test, context) {
    // extract some config information
    const mappedContentTypes = config.contentTypes || {};

    // fetch the actual data from the source and our stored, "blessed" version
    return Promise.all([
      fetcher.fetchOutput(test, context).then(transformResult),
      blessedStore.fetch(test)
    ]).then(([actual, blessed]) => {
        // find the right format plugin to use for the type of data we have (HTML, JSON, etc.)
        let mimeType = actual.keyProps.type;
        if (mappedContentTypes[mimeType])
          mimeType = mappedContentTypes[mimeType];

        let formatPlugin = _.find(formatPlugins, p => p.mimeTypes.indexOf(mimeType) >= 0);
        if (!formatPlugin) {
          // fallback to a generic format (text/plain, by default)
          formatPlugin = _.find(formatPlugins, p => p.mimeTypes.indexOf('*') >= 0);
        }
        const format = formatPlugin.create(suite, test);
        test.format = format;

        // if we don't have any blessed content yet - must be a new test
        if (!blessed) {
          return {status: 'new', test, actual, blessed};
        }

        // compare key properties - if a key property changes, there is no point
        // in comparing contents. these are things like mime type or status code,
        // which usually means that if they change, the contents returned by the
        // test have nothing to do with the blessed ones.
        if (!_.isEqual(actual.keyProps, blessed.keyProps)) {
          return {
            status: 'key props changed',
            message: "Key properties of the returned output have changed.",
            test, actual, blessed
          };
        }

        // compare using format-specific logic
        const changes = format.compare(actual.value, blessed.value, context);

        // return the final verdict
        if (changes.length > 0) {
          return {status: 'changed', test, actual, blessed, changes};
        } else {
          return {status: 'ok', test, actual, blessed};
        }
      });
  }

  function blessTest(testResult) {
    const {test, actual} = testResult;
    return blessedStore.store(test, actual);
  }

  function testsToRun(suite) {
    const testRegex = new RegExp(config.onlyTestsMatching);
    return suite.tests
      .map(t => new ChaplainTest(suite, t))
      .filter(t => t.key().match(testRegex));
  }

  function performSetup(context) {
    // collect all the relevant setup/teardown plugins
    // this means plugins that were triggered by a property
    // somewhere in our suite configuration
    const stds = config.plugins
      .filter(p => p.plugin == 'setup-teardown')
      .filter(p => pluginTriggered(p, suite))
      .map(p => p.create(suite));

    context.__teardowns = stds;
    return Promise.all(stds.map(std =>
        std.setup(context)
    ));
  }

  function performTeardown(context) {
    const stds = context.__teardowns || [];
    return Promise.all(stds.map(std =>
        std.teardown(context)
    ));
  }
}
