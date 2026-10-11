'use strict';
// Test-only preload. The existing production telemetry implementation is unchanged.
// Prevent fixture account/billing regressions from emitting real HeyCatch events.
const Module=require('node:module'),load=Module._load;
Module._load=function(request,parent,isMain){
  if(request==='@heycatch/sdk')return{analytics:{init(){},setIdentity(){return Promise.resolve()},trackEvent(){return Promise.resolve()},resetIdentity(){return Promise.resolve()}}};
  return load.call(this,request,parent,isMain);
};
