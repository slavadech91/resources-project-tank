import {appearanceFamily,type AppearanceMap,type AppearanceStyle} from '../../../html5/src/net2/appearance.ts';
import type {Database} from '../db/mysql.ts';
import {RequestError} from '../errors.ts';
import type {GarageCatalog} from './catalog.ts';
/** Tiny per-user/family preferences; no work in the physics tick and no gameplay config edits. */
export class AppearanceStore{
 constructor(private readonly db:Database,private readonly catalog:GarageCatalog){}
 async init():Promise<void>{await this.db.query(`CREATE TABLE IF NOT EXISTS S2Appearance (user_id INT UNSIGNED NOT NULL, family VARCHAR(40) NOT NULL, style VARCHAR(8) NOT NULL, PRIMARY KEY(user_id,family)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);}
 async get(userId:number):Promise<AppearanceMap>{const {rows}=await this.db.query<{family:string;style:AppearanceStyle}>('SELECT family,style FROM S2Appearance WHERE user_id=?',[userId]);const result:AppearanceMap={};for(const row of rows)if(row.style==='old'||row.style==='gen2')result[row.family]=row.style;return result;}
 async set(userId:number,itemId:number,style:unknown):Promise<AppearanceMap>{
  if(style!=='old'&&style!=='gen2')throw new RequestError('bad_request','неизвестный вариант оформления');
  const item=this.catalog.get(itemId),family=item?appearanceFamily(item.objectPath??''):null;
  if(!family)throw new RequestError('bad_request','для этой детали нет отдельного Old-варианта');
  await this.db.query('INSERT INTO S2Appearance (user_id,family,style) VALUES (?,?,?) ON DUPLICATE KEY UPDATE style=VALUES(style)',[userId,family,style]);return this.get(userId);
 }
}
