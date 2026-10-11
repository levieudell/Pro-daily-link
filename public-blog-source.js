'use strict';
const fs=require('node:fs');
function loadPublishedPost(file,slug){
  if(typeof slug!=='string'||!/^[a-z0-9-]+$/.test(slug)||!fs.existsSync(file))return null;
  // Avoid readPlatform(): its legacy support-library seeding can persist records.
  const platform=JSON.parse(fs.readFileSync(file,'utf8'));
  const posts=Array.isArray(platform.blogPosts)?platform.blogPosts:[];
  return posts.find(row=>row.status==='Published'&&row.slug===slug)||null;
}
module.exports={loadPublishedPost};
