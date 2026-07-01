import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
const PORT = 8123;
const root = process.cwd();
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json'};
http.createServer(async (req,res)=>{
  try{
    let p = decodeURIComponent(req.url.split('?')[0]);
    if(p==='/')p='/index.html';
    const fp = normalize(join(root,p));
    if(!fp.startsWith(root)){res.writeHead(403);return res.end('forbidden');}
    const data = await readFile(fp);
    res.writeHead(200,{'Content-Type':types[extname(fp)]||'application/octet-stream'});
    res.end(data);
  }catch(e){res.writeHead(404);res.end('not found');}
}).listen(PORT,()=>console.log('serving on http://localhost:'+PORT));
