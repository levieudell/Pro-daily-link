(function(root){
  'use strict';
  const origin='https://app.prodailylink.com';
  function articleMetadata(post){
    // Preserve published source text, including long titles. Never invent an author/date.
    const title=`${post.title} · Pro Daily Link`;
    const canonical=`${origin}/blog.html?post=${encodeURIComponent(post.slug)}`;
    const schema={'@context':'https://schema.org','@type':'BlogPosting',headline:post.title,description:post.excerpt,url:canonical,mainEntityOfPage:canonical,publisher:{'@id':`${origin}/#organization`},image:`${origin}/assets/og-image.png`};
    if(post.author) schema.author={'@type':'Person',name:post.author};
    for(const [key,value] of [['datePublished',post.publishedAt],['dateModified',post.updatedAt]]){
      if(value && Number.isFinite(Date.parse(value))) schema[key]=new Date(value).toISOString();
    }
    return {title,canonical,schema,titleNeedsReview:title.length<30||title.length>60,descriptionNeedsReview:String(post.excerpt||'').length<110||String(post.excerpt||'').length>160};
  }
  function applyArticleMetadata(post,doc){
    const metadata=articleMetadata(post);
    doc.title=metadata.title;
    const canonical=doc.querySelector('link[rel="canonical"]');canonical.href=metadata.canonical;
    doc.querySelector('meta[name="description"]').content=post.excerpt||'';
    for(const key of ['og:title','twitter:title']) doc.querySelector(`meta[${key.startsWith('og:')?'property':'name'}="${key}"]`).content=metadata.title;
    for(const key of ['og:description','twitter:description']) doc.querySelector(`meta[${key.startsWith('og:')?'property':'name'}="${key}"]`).content=post.excerpt||'';
    doc.querySelector('meta[property="og:url"]').content=metadata.canonical;
    doc.querySelector('#page-schema').textContent=JSON.stringify(metadata.schema);
    doc.querySelector('.blog-hero').hidden=true;
    if(metadata.titleNeedsReview||metadata.descriptionNeedsReview) console.warn('Published article metadata needs editorial length review; source text was preserved.',{titleLength:metadata.title.length,descriptionLength:String(post.excerpt||'').length});
    return metadata;
  }
  function renderArticleHead(html,post){
    const metadata=articleMetadata(post),escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    html=html.replace(/<title>.*?<\/title>/s,()=>`<title>${escape(metadata.title)}</title>`);
    html=html.replace(/(<link rel="canonical" href=")[^"]*(">)/,`$1${escape(metadata.canonical)}$2`);
    for(const [attribute,key,value] of [['name','description',post.excerpt],['property','og:title',metadata.title],['name','twitter:title',metadata.title],['property','og:description',post.excerpt],['name','twitter:description',post.excerpt],['property','og:url',metadata.canonical]]){
      const expression=new RegExp(`(<meta ${attribute}="${key}" content=")[^"]*(">)`);
      html=html.replace(expression,(_,before,after)=>before+escape(value)+after);
    }
    return html.replace(/(<script id="page-schema" type="application\/ld\+json">).*?(<\/script>)/s,(_,before,after)=>before+JSON.stringify(metadata.schema).replace(/</g,'\\u003c')+after);
  }
  const api={articleMetadata,applyArticleMetadata,renderArticleHead};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PDLBlogMetadata=api;
})(typeof window==='undefined'?globalThis:window);
