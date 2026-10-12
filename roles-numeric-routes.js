'use strict';
// These are named numeric resource collections. Guest tokens, files, UUIDs and
// arbitrary client permission keys are never interpreted as resource IDs.
const collections=new Set(['projects','assignments','reports','workdays','team','users','customers','changes','catalog','subcontractors','time-cards','timecards','activities','notes','tasks','project-tasks','estimate-items','estimate-proposals','plans','tickets','photos']);
function assert(url){const parts=url.pathname.split('/');if(parts[1]!=='api'||['guest','change-order','files','local-files'].includes(parts[2]))return;for(let i=2;i<parts.length-1;i++)if(collections.has(parts[i])&&/^\d+$/.test(parts[i+1])&&(!/^[1-9]\d*$/.test(parts[i+1])||!Number.isSafeInteger(Number(parts[i+1]))))throw Object.assign(Error('Use the current canonical resource ID.'),{statusCode:400,code:'PDL_RESOURCE_ID'});}
module.exports={assert};
