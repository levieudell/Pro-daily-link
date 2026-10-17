'use strict';
// Tests must never send synthetic identities or billing events to live analytics.
// Install before server.js (including in spawned test servers), without changing
// the production SDK or its runtime configuration.
const sdkPath=require.resolve('@heycatch/sdk');
const noop=()=>{};
require.cache[sdkPath]={id:sdkPath,filename:sdkPath,loaded:true,exports:{analytics:{
  init:noop,optInCapturing:noop,optOutCapturing:noop,resetIdentity:noop,
  setIdentity:noop,setPersonProperties:noop,trackEvent:noop
}}};
