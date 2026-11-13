// In-memory peers only: no login, sockets, database or user accounts.
import assert from 'node:assert/strict';
import {LobbyChatService} from '../src/chat/lobbyChat.ts';
const service=new LobbyChatService();
const peer=(id:number)=>({user:{id,name:`User${id}`,rank:id} as any,events:[] as any[],send(_type:string,data:any){this.events.push(data.message);}});
const a=peer(1),b=peer(2),c=peer(3);
assert.throws(()=>service.watch({...a,user:null}),/not_authenticated/);
assert.throws(()=>service.send(a,'not subscribed'),/откройте чат/);
assert.deepEqual(service.watch(a),[]);service.watch(b);
service.send(a,'  привет\nмир  ',1000);assert.equal(a.events[0].text,'привет мир');assert.equal(b.events[0].author,'User1');assert.equal(b.events[0].rank,1);assert.equal(c.events.length,0);
assert.throws(()=>service.send(a,'too fast',1500),/секунду/);
service.unwatch(b);service.send(a,'second',2000);assert.equal(b.events.length,1);
assert.throws(()=>service.send(a,'x'.repeat(300),3000));
service.send(a,'<img onerror=alert(1)>',3000);assert.equal(a.events.at(-1).text,'<img onerror=alert(1)>','wire text stays plain; UI uses textContent');
for(let i=0;i<85;i++)service.send(a,`message ${i}`,4000+i*1000);
const history=service.watch(c);assert.equal(history.length,80);assert.equal(history.at(-1)!.text,'message 84');assert.equal(new Set(history.map(m=>m.messageId)).size,80);
history[0].text='tamper';assert.notEqual(service.watch(c)[0].text,'tamper');
service.remove(a);assert.throws(()=>service.send(a,'closed',100000),/откройте чат/);service.watch(a);service.send(a,'new session',100000);
console.log('Lobby chat: authentication, membership, broadcast, identity, bounded history, ordering, rate/length limits, history isolation and cleanup OK');

service.watch(b);service.send(a,'user2: Привет адресату',101000);
const addressed=b.events.at(-1);assert.equal(addressed.text,'Привет адресату');assert.deepEqual(addressed.recipient,{userId:2,author:'User2',rank:2});assert.equal(addressed.author,'User1');
service.send(a,'Unknown: обычный текст',102000);assert.equal(a.events.at(-1).recipient,undefined);assert.equal(a.events.at(-1).text,'Unknown: обычный текст');
const snap=service.watch(c),lastAddress=snap.find(m=>m.recipient);lastAddress!.recipient!.author='tamper';assert.equal(service.watch(c).find(m=>m.recipient)!.recipient!.author,'User2');
console.log('Lobby chat addresses: canonical recipient/rank, body separation, unknown names remain text, nested history snapshot isolated OK');
