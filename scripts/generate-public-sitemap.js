'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const entries=[['/','landing.html'],['/about.html','about.html'],['/blog.html','blog.html'],['/vs/raken.html','vs/raken.html'],['/vs/procore.html','vs/procore.html'],['/vs/paper-daily-logs.html','vs/paper-daily-logs.html'],['/terms.html','terms.html'],['/privacy.html','privacy.html']];
function generate(lastModified){
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+entries.map(([url,file])=>{
    const date=lastModified(file);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error(`Missing genuine modification date for ${file}`);
    return `  <url><loc>https://app.prodailylink.com${url}</loc><lastmod>${date}</lastmod></url>`;
  }).join('\n')+'\n</urlset>\n';
}
if(require.main===module){
  const xml=generate(file=>execFileSync('git',['log','-1','--format=%cI','--',file],{cwd:root,encoding:'utf8'}).trim().slice(0,10));
  const target=path.join(root,'sitemap.xml');
  if(process.argv.includes('--check')){if(fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n')!==xml)throw new Error('Sitemap differs from committed public-page modification dates. Run npm run sitemap:generate after committing page changes.');}
  else fs.writeFileSync(target,xml);
}
module.exports={entries,generate};
