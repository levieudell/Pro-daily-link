'use strict';
const {platformTopics,saveTopic}=require('./safety-program');
function createPlatformSafetyHandler({readPlatform,writePlatform,body,json,canRead,canWrite,audit}) {
  return async(req,res,url)=>{
    const match=url.pathname.match(/^\/api\/platform\/safety-topics(?:\/([^/]+))?$/);if(!match)return false;
    const reply=(status,data)=>{json(res,status,data);return true;};
    if(!req.platformAuth?.user)return reply(401,{error:'Platform authentication required'});
    if(!(req.method==='GET'?canRead(req):canWrite(req)))return reply(403,{error:'Content publishing permission required'});
    const platform=readPlatform();
    if(req.method==='GET'&&!match[1])return reply(200,platformTopics(platform));
    if(!['POST','PATCH'].includes(req.method))return reply(405,{error:'Method not supported'});
    try{
      const input=await body(req);platform.safetyTopics ||= [];
      const current=match[1]&&platformTopics(platform).find(row=>row.id===match[1]);
      if(match[1]&&!current)return reply(404,{error:'Topic not found'});
      const row=saveTopic(platform.safetyTopics,input,req.platformAuth.user,current);
      audit(platform,req,'safety_topic_saved',`${row.title} · ${row.status} · revision ${row.revision}`);
      await writePlatform(platform,{changedBy:String(req.platformAuth.user.id)});return reply(current?200:201,row);
    }catch(error){if(error.statusCode)return reply(error.statusCode,{error:error.message});throw error;}
  };
}
module.exports={createPlatformSafetyHandler};
