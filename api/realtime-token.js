export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  const key=process.env.OPENAI_API_KEY;
  if(!key) return res.status(500).json({error:"OPENAI_API_KEY missing"});
  try{
    const r=await fetch("https://api.openai.com/v1/realtime/client_secrets",{
      method:"POST",headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},
      body:JSON.stringify({session:{type:"realtime",model:"gpt-realtime",audio:{output:{voice:"marin"}},instructions:`أنت مصروفي، مساعد مالي عربي صوتي. تحدث بطلاقة وباختصار. افهم أوامر المستخدم الطبيعية. عند إضافة أو تعديل أو حذف عملية استخدم أدوات التطبيق. لا تخمن المبلغ أو الحساب إن كانا غامضين؛ اسأل سؤال متابعة واحداً.`}})
    });
    const data=await r.json(); return res.status(r.status).json(data);
  }catch(e){return res.status(500).json({error:String(e)})}
}
