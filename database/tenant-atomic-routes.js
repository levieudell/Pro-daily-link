'use strict';
const { classify } = require('../capability-operations');
function supportedRoute(method, pathname) { return Boolean(classify(method, pathname)); }
module.exports = { supportedRoute };
