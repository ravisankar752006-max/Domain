const BASE = 'http://localhost:4000';
const fetch = global.fetch || require('node-fetch');

async function run(){
  console.log('Register (may already exist)');
  try{
    let r = await fetch(BASE + '/api/register', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({username:'tester', password:'pass123'})});
    console.log('register:', await r.json());
  }catch(e){ console.log('register error', e.message); }

  console.log('\nLogin');
  let r = await fetch(BASE + '/api/login', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({username:'tester', password:'pass123'})});
  const login = await r.json();
  console.log('login:', login);
  if (!login.token) { console.error('Login failed'); process.exit(1); }
  const token = login.token;

  const auth = { headers: {'content-type':'application/json', 'authorization': 'Bearer ' + token} };

  console.log('\nCreate project');
  r = await fetch(BASE + '/api/projects', Object.assign({method:'POST', body: JSON.stringify({name:'Test Project'})}, auth));
  const proj = await r.json(); console.log('project:', proj);
  const pid = proj.id;

  console.log('\nCreate task');
  r = await fetch(BASE + `/api/projects/${pid}/tasks`, Object.assign({method:'POST', body: JSON.stringify({title:'First Task', assignee:'tester'})}, auth));
  const task = await r.json(); console.log('task:', task);
  const tid = task.id;

  console.log('\nUpdate task');
  r = await fetch(BASE + `/api/tasks/${tid}`, Object.assign({method:'PUT', body: JSON.stringify({status:'inprogress'})}, auth));
  console.log('updated task:', await r.json());

  console.log('\nPost comment');
  r = await fetch(BASE + `/api/tasks/${tid}/comments`, Object.assign({method:'POST', body: JSON.stringify({body:'Looks good'})}, auth));
  console.log('comment:', await r.json());

  console.log('\nPost message');
  r = await fetch(BASE + `/api/projects/${pid}/messages`, Object.assign({method:'POST', body: JSON.stringify({body:'Welcome to the project chat'})}, auth));
  console.log('message:', await r.json());

  console.log('\nFinish project');
  r = await fetch(BASE + `/api/projects/${pid}/finish`, Object.assign({method:'POST'}, auth));
  console.log('finished:', await r.json());

  console.log('\nGet project detail');
  r = await fetch(BASE + `/api/projects/${pid}`, Object.assign({method:'GET'}, auth));
  console.log('project detail:', await r.json());

  console.log('\nSmoke test completed');
}

run().catch(e=>{console.error('smoke error', e); process.exit(1)});
