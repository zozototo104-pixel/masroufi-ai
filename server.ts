import fs from 'fs';
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality, FunctionCall } from "@google/genai";
import dotenv from "dotenv";
import { functionDeclarations, toolHandlers } from "./src/server/tools";
import { adminAuth } from "./src/server/firebaseAdmin";
import {
  authMiddleware,
  issueDirectLoginToken,
  verifyBearer,
  type WSAuthState,
} from "./src/server/auth";
import { dispatchFinancialCommand, isValidFinancialCommandType } from "./src/server/financialEngine";

dotenv.config();

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);

  const PORT = Number(process.env.PORT || 3000);

  // HTTP server — Render injects PORT and requires binding on 0.0.0.0.
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, closing HTTP/WebSocket server...`);
    server.close(() => {
      console.log("Server closed cleanly.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // WebSocket Server for Live API
  const wss = new WebSocketServer({ server, path: '/live' });

  // Add Gemini Live setup here
  setupLiveApi(wss);

  app.use(express.json({ limit: '10mb' }));

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Safari & Mobile friendly direct authentication using Firebase Custom Tokens.
  // V6: replaces unsigned masrofi_token_ bypass (CF-1). Server mints a real
  // Firebase Custom Token via Admin SDK; client calls signInWithCustomToken.
  app.post("/api/auth/safari-token", async (req: any, res: any) => {
    try {
      const { email } = req.body || {};
      const result = await issueDirectLoginToken(email);
      if (!result.success) {
        return res.status(400).json({ error: result.error || 'فشل إصدار التوكن' });
      }
      res.json({
        success: true,
        // Note: this is a Firebase Custom Token, NOT a session token. Client must call
        // signInWithCustomToken(customToken) and then use the resulting ID token as Bearer.
        customToken: result.customToken,
        user: {
          uid: result.uid,
          email: result.email,
          displayName: result.displayName
        }
      });
    } catch (error: any) {
      console.error("Safari direct token error:", error);
      res.status(500).json({ error: "فشل التحقق: " + (error.message || "خطأ غير معروف") });
    }
  });

  app.post("/api/scan-receipt", authMiddleware, async (req: any, res: any) => {
    const { imageBase64, mimeType, apiKey: customApiKey } = req.body;
    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: "Missing image data" });
    }

    try {
      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No API key");

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Analyze this receipt / invoice image in detail. Extract both the store/merchant name, the overall total, and breakdown all individual purchased items.
Return ONLY a valid JSON object matching this schema without markdown code blocks:
{
  "merchant": "Store or merchant name",
  "totalAmount": 120,
  "date": "YYYY-MM-DD",
  "items": [
    {
      "name": "Item name / description in Arabic",
      "amount": 30.5,
      "category": "Main Category in Arabic: 'الأبناء' | 'طعام ومشتريات منزل' | 'زيارات وضيافة' | 'مواصلات' | 'فواتير والتزامات' | 'صحة وعلاج' | 'أخرى'",
      "subcategory": "Specific subcategory like 'خضار وفواكه', 'منظفات', 'لحوم', 'أدوية', 'ملابس'...",
      "necessity": "'ضروري' or 'كمالي'"
    }
  ]
}
If individual line items cannot be broken down, provide a single item in the items array with the total amount.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: imageBase64, mimeType } },
              { text: prompt }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const jsonText = response.text;
      if (!jsonText) throw new Error("No response text");
      
      const parsed = JSON.parse(jsonText);
      const { addTransaction } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];

      const createdTransactions: any[] = [];
      const items = Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed.items : [
        {
          name: "مشتريات من " + (parsed.merchant || "المتجر"),
          amount: parsed.totalAmount || parsed.amount || 0,
          category: parsed.category || "طعام ومشتريات منزل",
          subcategory: parsed.subcategory || "عام",
          necessity: "ضروري"
        }
      ];

      for (const item of items) {
        const itemAmount = Math.abs(Number(item.amount) || 0);
        if (itemAmount <= 0) continue;

        const txArgs = {
          amount: itemAmount,
          type: 'expense',
          account: 'cash',
          category: item.category || 'طعام ومشتريات منزل',
          subcategory: item.subcategory || item.name || 'مشتريات',
          merchant: parsed.merchant || 'متجر',
          notes: item.name || 'تم تسجيلها عبر الماسح الضوئي للفاتورة',
          paymentMethod: 'cash',
          necessity: item.necessity || 'ضروري'
        };

        const result = await addTransaction(txArgs, req.user.uid, token);
        createdTransactions.push({ ...txArgs, id: result.transactionId });
      }

      res.json({
        success: true,
        merchant: parsed.merchant || 'متجر',
        totalAmount: parsed.totalAmount || createdTransactions.reduce((s, t) => s + t.amount, 0),
        itemsCount: createdTransactions.length,
        items: createdTransactions
      });
    } catch (error: any) {
      console.error("Scanner error:", error);
      res.status(500).json({ error: "Failed to scan receipt: " + error.message });
    }
  });

  app.get("/api/budgets", authMiddleware, async (req: any, res: any) => {
    try {
      const { getBudgetsOverview } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await getBudgetsOverview({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/budgets", authMiddleware, async (req: any, res: any) => {
    try {
      const { setCategoryBudget } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { category, limit } = req.body;
      const result = await setCategoryBudget({ category, limit }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/commitments", authMiddleware, async (req: any, res: any) => {
    try {
      const { getCommitments } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await getCommitments({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/commitments", authMiddleware, async (req: any, res: any) => {
    try {
      const { createCommitment } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await createCommitment(req.body, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/commitments/:id", authMiddleware, async (req: any, res: any) => {
    try {
      const { deleteCommitment } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await deleteCommitment({ id: req.params.id }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // V6 (MF-1): commitment lifecycle status update.
  app.patch("/api/commitments/:id/status", authMiddleware, async (req: any, res: any) => {
    try {
      const { updateCommitmentStatus } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await updateCommitmentStatus({ id: req.params.id, status: req.body.status }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // User Memory Endpoints (for smart assistant recall)
  app.get("/api/memory", authMiddleware, async (req: any, res: any) => {
    try {
      const { memorySearch } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await memorySearch({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memory", authMiddleware, async (req: any, res: any) => {
    try {
      const { memorySave } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { key, value } = req.body;
      if (!key || !value) return res.status(400).json({ error: "Missing key or value" });
      const result = await memorySave({ key, value }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memory/:key", authMiddleware, async (req: any, res: any) => {
    try {
      const { deleteMemoryKey } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await deleteMemoryKey({ key: req.params.key }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/notifications", authMiddleware, async (req: any, res: any) => {
    try {
      const { getNotifications } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await getNotifications(req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/notifications/:id/read", authMiddleware, async (req: any, res: any) => {
    try {
      const { markNotificationRead } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await markNotificationRead({ id: req.params.id }, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  app.post("/api/sync", authMiddleware, async (req: any, res: any) => {
    try {
      const { syncOfflineData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await syncOfflineData(req.body, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      // V6 (CF-2): OwnershipError from syncOfflineData should return 403, not 500.
      const status = e?.status && Number.isFinite(e.status) ? e.status : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // V6.2 (FINDING-03/04/06): Financial command dispatch endpoint.
  // Offline replay MUST route through this endpoint (NOT /api/sync).
  // /api/sync is restricted to NON-FINANCIAL state only (reports, commitment status).
  // Financial mutations (transactions, transfers, debt payments, PalPay payments,
  // updates, deletes) go through /api/command which calls dispatchFinancialCommand.
  // dispatchFinancialCommand routes to the SAME tool handlers used by online AI calls,
  // so ALL financial validation (overpayment, insufficient funds, debt guards, etc.)
  // is applied. NO backdoor.
  app.post("/api/command", authMiddleware, async (req: any, res: any) => {
    try {
      const { command } = req.body || {};
      if (!command || !command.commandType || !command.operationId) {
        return res.status(400).json({ error: 'Missing command.commandType or command.operationId' });
      }
      if (!isValidFinancialCommandType(command.commandType)) {
        return res.status(400).json({ error: `Unknown command type: ${command.commandType}` });
      }
      const token = req.headers.authorization.split('Bearer ')[1];
      // V6.2 (FINDING-07 SYNC-AUTH-01): force userId = authenticated UID.
      // The dispatchFinancialCommand function will overwrite command.userId.
      const result = await dispatchFinancialCommand(command, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      const status = e?.status && Number.isFinite(e.status) ? e.status : 500;
      res.status(status).json({ error: e.message });
    }
  });

  app.get("/api/transactions", authMiddleware, async (req: any, res: any) => {
    try {
      const { queryTransactions } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await queryTransactions({ period: 'custom' }, req.user.uid, token); 
      res.json(result);
    } catch (e: any) {
      fs.appendFileSync("app-errors.log", "Transactions Error: " + e.message + "\n"); console.error("Transactions Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/reports", authMiddleware, async (req: any, res: any) => {
    const { getReports } = await import('./src/server/tools');
    const token = req.headers.authorization.split('Bearer ')[1];
    const result = await getReports({}, req.user.uid, token);
    res.json(result);
  });

  app.delete("/api/reports/:id", authMiddleware, async (req: any, res: any) => {
    try {
      const { deleteReport } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await deleteReport({ id: req.params.id }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Delete report API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/reports", authMiddleware, async (req: any, res: any) => {
    try {
      const { clearAllReports } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await clearAllReports({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Clear all reports API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/reports/generate", authMiddleware, async (req: any, res: any) => {
    try {
      const { generateReport } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { title, timeframe = 'all', category } = req.body;
      const result = await generateReport({ title, timeframe, category }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Generate report API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Data Export Endpoint
  app.get("/api/data/export", authMiddleware, async (req: any, res: any) => {
    try {
      const { exportUserData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const backupData = await exportUserData(req.user.uid, token);
      res.json(backupData);
    } catch (e: any) {
      console.error("Export data error:", e.message);
      res.status(500).json({ error: "Failed to export data: " + e.message });
    }
  });

  // Data Import Endpoint
  app.post("/api/data/import", authMiddleware, async (req: any, res: any) => {
    try {
      const { importUserData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { payload, mode = 'merge' } = req.body;
      if (!payload) {
        return res.status(400).json({ error: "Missing payload to import." });
      }
      const result = await importUserData(payload, req.user.uid, token, mode);
      res.json(result);
    } catch (e: any) {
      console.error("Import data error:", e.message);
      res.status(500).json({ error: "Failed to import data: " + e.message });
    }
  });

  // Data Wipe All Endpoint (clears all user transactions, budgets, commitments, reports, and disk cache)
  app.delete("/api/data/wipe", authMiddleware, async (req: any, res: any) => {
    try {
      const { wipeAllUserData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await wipeAllUserData(req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Wipe all data error:", e.message);
      res.status(500).json({ error: "Failed to wipe data: " + e.message });
    }
  });

  app.post("/api/chat", authMiddleware, async (req: any, res: any) => {
    try {
      const { message, history = [], userName = "يا صديقي", aiName = "مصروفي", relationship = "", persona = "friendly", apiKey: customApiKey } = req.body;
      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No API key");

      const personalityMap: Record<string, string> = {
        friendly: "ودود وعفوي وخفيف الدم",
        playful: "مرح جداً ومشاكس بلطف ويستخدم الدعابة الطبيعية دون إفساد الجدية المالية",
        warm: "حنون وداعم ودافئ في الحديث",
        romantic: "رومانسي ودافئ ومحب إذا كان سياق العلاقة يسمح بذلك، دون مبالغة أو تعطيل الدقة المالية",
        professional: "رسمي ومهني ومنهجي",
        strict: "صارم وحازم مالياً مع الحفاظ على الاحترام"
      };
      const relationshipContext = relationship ? `علاقتك بالمستخدم كما عرّفها هو: "${relationship}". افهمها كسياق علاقة وتصرّف وفقها طبيعياً، ولا تضمها إلى اسمك ولا تكررها آلياً. مثال: إذا كان اسمك تغريد والعلاقة زوجتي، فاسمك تغريد وعلاقتك به زوجته، وليس اسمك "تغريد زوجتي".` : "لا توجد علاقة خاصة محددة؛ تعامل كمساعد مالي شخصي.";
      const systemInstruction = `أنت مساعد ومستشار مالي شخصي ذكي. اسمك هو "${aiName}".
أسلوبك: ${personalityMap[persona] || personalityMap.friendly}.
${relationshipContext}
أنت تتحدث الآن مع المستخدم الذي اسمه: "${userName}". 
1. مهمتك مساعدة المستخدم في إدارة أمواله وتسجيل عملياته واستخراج تقارير تفصيلية شاملة.
2. وضعك الأساسي هو **أمين الصندوق الذكي**: لا توافق المستخدم لمجرد أنه يريد الصرف؛ احمِ رصيده وادخاره وميزانيته، واعترض بالأرقام عندما يلزم.

🛑 **قواعد إلزامية ومهمة جداً (إياك مخالفتها)**:
0- **لا رؤية وهمية**: لا تؤكد أي إضافة/تحويل/تعديل/حذف/سداد قبل أن تعود الأداة بنتيجة success=true. إذا أعادت needsClarification فاسأل فقط عن الحقل الناقص. إذا فشلت الأداة فقل إنها لم تُنفذ. لا تعتبر الرد الكلامي تنفيذًا مالياً.
0.1- **التحويل الداخلي**: تحويل cash↔PalPay ليس دخلاً ولا مصروفاً ويجب استخدام transfer_money فقط. لا تنشئ عمليتي دخل/مصروف لمحاكاة التحويل.
0.2- **الحذف والتعديل**: إذا كانت العملية المقصودة غير فريدة، لا تخمن أحدث عملية. اطلب تحديدها. التعديل يجب أن يغير نفس السجل ولا ينشئ عملية مالية جديدة.
0.3- **المستشار الاستباقي V5**: فرّق بين نية الشراء وبين حدوث الشراء. إذا قال المستخدم "بدي أشتري/بفكر أشتري/شو رأيك أشتري" فلا تسجل عملية. للشراء المهم أو المكلف استخدم assess_purchase أولاً، واستدعِ get_financial_decision_context عندما تحتاج صورة مالية أوسع. ناقشه بالأرقام الفعلية: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، وتوقع 30 يوماً. تدخّل في الوقت المناسب لكن لا تزعجه بتنبيهات على كل مصروف صغير.
0.4- **السوق المحلي الحقيقي**: عندما يكون القرار مرتبطاً بسعر سلعة حالية، اجمع اسم السلعة والموديل/المواصفات أولاً ثم استخدم search_local_market. لا تقل "موجود عند فلان بكذا" إلا إذا أعادت الأداة مصدراً حقيقياً. إذا لم تجد سعراً محلياً موثوقاً في غزة، قل ذلك صراحة ولا تخترع متجراً أو سعراً. السعر الخارجي معلومة مساعدة وليس أمراً بالشراء.
0.5- **التحذير قبل التنفيذ**: إذا أعادت أداة مالية needsConfirmation=true، لا تنفذ ولا تؤكد. اشرح الخطر باختصار واسأل المستخدم هل يريد المتابعة. إذا وافق صراحة، أعد نفس العملية مع riskConfirmed=true. إذا رفض، لا تسجل شيئاً.
0.6- **أسلوب الإقناع**: استخدم شخصية المساعد المختارة في النقاش (يمكن المزاح في playful/romantic/warm) لكن الأرقام والحقائق لا تتغير. مثال مرح مسموح إذا كانت البيانات تدعمه: "يا زلمة، هيك بتضغط حالك آخر الشهر 😄". لا تستخدم التوبيخ أو الادعاءات السعرية بلا دليل.
0.7- **V6.1 — المتانة (Durability)**: عندما تعيد أداة مالية durability=pending أو pending=true، هذا يعني أن العملية لم تصل التخزين السحابي بعد بل هي في قائمة انتظار محلية. لا تقل "تم" أو "حفظت" أو "سجلتها". قل بصدق: "سجّلت العملية لكنها معلّقة للمزامنة — ستصل السحابة عند عودة الاتصال". لا توهم المستخدم بنجاح غير مؤكد.
0.8- **V6.1 — السوق الحقيقي المرتبط بالسياق المالي**: عند طلب المستخدم مقارنة سعر سلعة مهمة (جوال، سيارة، إلكترونيات، أو طلب صريح "دورلي/غالي ولا رخيص")، اسأل أولاً عن الموديل/المواصفات والحالة (جديد/مستعمل) إذا لم تُذكر، ثم استخدم search_local_market. ادمج النتيجة مع السياق المالي: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، توقع 30 يوماً. لا تقدم سعر السوق بمعزل عن الواقع المالي للمستخدم. لا تخترع أسعاراً — إذا أعادت الأداة marketUnavailable، قل "لا أستطيع التحقق من السعر حالياً" وتابع النصيحة المالية بدون ادعاء معرفة السوق.
0.9- **V6.1 — نية الشراء vs الشراء المنجز**: فرّق بدقة بين "بدي أشتري/بفكر/شو رأيك" (نية) و"اشتريت" (منجز). النية = استخدم assess_purchase و search_local_market، لا تسجّل عملية. المنجز = اسأل عن طريقة الدفع ثم سجّل بـ add_transaction. الاختلاط بينهما يفسد البيانات المالية.
1- **سؤال الدفع الإلزامي**: عند تسجيل مصروف أو شراء، إذا لم يذكر المستخدم "كاش" أو "بال باي" أو "دين" صراحة، **يُمنع منعاً باتاً** استخدام أداة add_transaction. اسأله فوراً: "هل دفعت كاش أم من محفظة بال باي أم سجلتها ديناً؟".
2- **سداد الدين الإلزامي**: عند طلب سداد دين، اجمع فقط المعلومات الناقصة: مبلغ السداد، حساب الدفع، والدائن المقصود عند وجود أكثر من دائن. لا تخمن الدائن. إذا أعادت pay_debt needsClarification فاطرح سؤال التوضيح ولا تؤكد النجاح قبل نجاح الأداة. إذا ذكر المستخدم الدائن والحساب بوضوح فلا تطرح أسئلة زائدة.
3- **التفرقة بين (استدانة المال) و (الشراء بالدين)**:
  - إذا قال المستخدم فقط "استدنت 500" أو "أخذت سلفة 500" ولم يوضح هل **استلم مالاً** أم **اشترى أغراضاً بالدين**، فهذا أمر مالي غامض: **لا تنفذ أي أداة**. اسأله باختصار: "استلمت المبلغ نقدي/PalPay، أم اشتريت أغراضاً بالدين؟".
  - **استدانة مال مستلم**: إذا أكد أنه استلم المال، استخدم **transfer_money** من debt إلى الحساب الذي استلم فيه المال. إذا لم يحدد هل استلمه cash أم PalPay، اسأل عن الحساب ولا تفترضه. يجب أيضاً معرفة الدائن. النتيجة: يزيد الحساب المستلم ويزيد الدين بنفس المبلغ، بينما **الدخل الحقيقي يبقى دون تغيير**. transactionType يجب أن يكون DEBT_BORROWING.
  - **شراء غرض بالدين**: إذا أكد أنه اشترى غرضاً بالدين، استخدم **add_transaction** كـ expense وحساب paymentMethod=debt. هذا يزيد المصروف والدين ولا يزيد cash أو PalPay. يجب حفظ الدائن/المحل. هذا النوع هو CREDIT_PURCHASE وليس دخلاً.
  - **سداد الدين**: استخدم pay_debt فقط؛ يخفض حساب الدفع والدين ولا ينشئ مصروفاً جديداً. transactionType=DEBT_PAYMENT.
4- **التسجيل اللفظي والفعلي**: عندما تقوم بتنفيذ عملية السداد عبر الأداة، تأكد من تأكيد ذلك لفظياً للمستخدم، فالأداة هي من تقوم بالخصم وتحديث البيانات على الشاشة. إياك أن ترد صوتياً وتنسى استدعاء الأداة.
- عندما يقول المستخدم "سديت دين" أو "دفعت دين" (مثل: "سديت دين 10 شيكل"):
  * **إياك إطلاقاً** أن تسجل سداد الدين كمصروف (add_transaction - expense). سداد الدين ليس مصروفاً جديداً! يجب استخدام pay_debt فقط.
  * إذا لم يذكر من أين دفع، **اسأله فوراً**: "هل سددت الدين نقداً (كاش) أم من محفظة PalPay؟".
  * فور تحديد الحساب، استخدم أداة \`pay_debt\` لتسجيل السداد، حيث تقوم الأداة بخصم المبلغ من رصيد الكاش أو PalPay وتخفيض إجمالي الديون في نفس اللحظة.

2. **التصنيف الهيكلي الدقيق للعمليات (add_transaction)**:
   - **بند الصرف الرئيسي (category)**: حدد دائماً البند الرئيسي (مثل: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم وتدريب', 'أخرى').
   - **بند الصرف الفرعي (subcategory)**: حدد دائماً وبدقة البند الفرعي:
     * تحت 'الأبناء': مصروف، ملابس، رسوم جامعة ومدرسة، دورة رسم، مستلزمات مدرسية، علاج، ألعاب...
     * تحت 'زيارات وضيافة': هدايا، مواصلات زيارة، ضيافة، حلويات، مطاعم...
     * تحت 'طعام ومشتريات منزل': خضار وفواكه، تموين، لحوم ودواجن، مخبوزات، منظفات...
     * تحت 'مواصلات': بنزين، تاكسي، صيانة وتصليح...
     * تحت 'فواتير والتزامات': كهرباء، ماء، إنترنت، إيجار...
     * تحت 'صحة وعلاج': كشفية طبيب، أدوية، تحاليل...
   - **المتجر (merchant)**: اسم المحل أو الشخص إن ذكر (مثل مكتبة النور، صيدلية القدس).
   - **البيان والتفاصيل (notes)**: تفصيل شو اشترى والملاحظات.
   - **طريقة الدفع (paymentMethod)**: 'cash' (كاش), 'palPay' (محفظة), أو 'debt' (دين).
   - **درجة الضرورة (necessity)**: 'ضروري' أو 'كمالي'، لكن لا تعتمد على تصنيف عالمي جامد. المستخدم يعيش في غزة وقد تختلف الأولويات جذرياً حسب الظروف المعيشية والأسعار وتوفر السلع. مثال: الفاكهة قد تكون كمالية في ظرف ضيق رغم أنها غذاء مفيد. استنتج من سياق المستخدم وما صرّح به؛ وإذا كان التصنيف غير واضح أو قابلًا للاختلاف، اسأله باختصار: "بتعتبرها عندك ضرورية ولا كمالية؟". لا تغيّر اختياره لاحقاً من نفسك.
   - **اكتمال القيد**: قبل add_transaction اجمع amount + type + category + subcategory + paymentMethod + necessity. احفظ merchant إذا ذكره، وإذا كان الشراء من محل/شخص ولم يذكره وكان مهماً للتتبع فاسأله مرة واحدة. notes يجب أن تلخص ما تم شراؤه. التاريخ الحالي يُستخدم تلقائياً ما لم يذكر تاريخاً آخر.
   - مثال: "اشتريت أواعي للعيال بـ200" → لا تنفذ فوراً إذا طريقة الدفع غير مذكورة. اسأل كاش/PalPay/دين، ثم سجّل category=الأبناء وsubcategory=ملابس وamount=200 وnotes=ملابس للأبناء وmerchant إن توفر وnecessity وفق ظروف المستخدم لا وفق افتراض عام.
3. **التقارير المالية**: إذا طلب تقريراً بسيطاً استخدم generate_report، وإذا طلب تقريراً شهرياً/ربعياً/سنوياً أو تفصيلاً حسب الأبناء أو بند رئيسي/فرعي أو تحليل تجاوزات ورسوم بيانية، استخدم generate_treasurer_report.
4. **الادخار**: استخدم create_savings_goal وget_savings_goals وadd_savings_contribution عند الحديث عن التحويشة، الاحتياطي، أهداف الشراء، تعليم الأبناء أو أي هدف مالي طويل.
5. **الدخل والراتب**: لا تسجل الراتب كاش تلقائياً؛ اسأل كم نقدي وكم PalPay، أو استخدم allocations إذا أعطى التوزيع.
6. لا تقل "تم تسجيل العملية بنجاح" بل تحدث بعفوية ومختصر.`;

      const ai = new GoogleGenAI({ apiKey });
      
      const formattedHistory = history.map((msg: any) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

      const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        history: formattedHistory,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: functionDeclarations as any }]
        }
      });

      // Set history if possible, but the SDK requires parsing it correctly.
      // For simplicity, we just send a single message with context if history is complex,
      // or we can just send the latest message.
      const response = await chat.sendMessage({ message });
      
      let replyText = response.text;
      
      // If there are function calls
      if (response.functionCalls && response.functionCalls.length > 0) {
        const functionResponses = await Promise.all(
          response.functionCalls.map(async (call: FunctionCall) => {
            const handler = toolHandlers[call.name];
            let responseData = { error: "Function not found" };
            if (handler) {
              try {
                const authToken = req.headers.authorization.split('Bearer ')[1];
                responseData = await handler(call.args || {}, req.user.uid, authToken);
              } catch (e: any) {
                responseData = { error: e.message };
              }
            }
            return { id: call.id, name: call.name, response: responseData };
          })
        );
        
        // Send tool response back to the model
        const secondResponse = await chat.sendMessage({ message: functionResponses as any });
        if (secondResponse.text) {
          replyText = secondResponse.text;
        }
      }

      const { getPendingOps } = await import('./src/server/fakeDb');
      const pendingOps = getPendingOps(req.user.uid);
      res.json({ success: true, text: replyText, pendingOps });
    } catch (error: any) {
      console.error("Text chat error:", error);
      if (error.message && error.message.includes("resource_exhausted")) {
        res.json({ success: true, text: "عذراً يا صديقي، لقد استنفدت الحد المسموح به مجاناً من خدمة الذكاء الاصطناعي (Gemini API Quota Exhausted). يرجى المحاولة لاحقاً أو الترقية." });
      } else {
        res.status(500).json({ error: "Failed to process chat: " + error.message });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

function setupLiveApi(wss: WebSocketServer) {
  wss.on("connection", (clientWs: WebSocket, req) => {
    console.log("Client connected to /live");

    // V6.3: Authenticate FIRST, then create the Gemini Live session.
    // The previous flow opened a Gemini session before auth and registered the
    // WS message handler only after that connection completed. Fast clients could
    // send the auth packet before the handler existed, causing auth timeouts and
    // wasting Gemini resources on unauthenticated sockets.
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const voice = url.searchParams.get("voice") || "Zephyr";
    const persona = url.searchParams.get("persona") || "friendly";
    const userName = url.searchParams.get("userName") || "يا صديقي";
    const aiName = url.searchParams.get("aiName") || "مصروفي";
    const relationship = url.searchParams.get("relationship") || "";
    // API keys are intentionally NOT read from the URL. URLs can appear in logs.

    const authState: WSAuthState = { authenticated: false };
    let userId: string | null = null;
    let userEmail: string | undefined = undefined;
    let userToken: string | undefined = undefined;
    const pendingAudio: string[] = [];

    let authTimeout: NodeJS.Timeout | null = setTimeout(() => {
      if (!authState.authenticated) {
        try {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ error: "Authentication timeout" }));
          }
          clientWs.close(4001, "auth timeout");
        } catch (e) { /* ignore */ }
      }
    }, 5000);

    const safeSend = (payload: any) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch (err) {
          console.warn("Failed to send message over clientWs:", err);
        }
      }
    };

    const pingInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
        } catch (e) { /* ignore */ }
      }
    }, 15000);

    let session: any = null;
    let sessionPromise: Promise<any> | null = null;
    let isActive = true;

    const connectGeminiSession = async (activeApiKey: string) => {
      if (sessionPromise || session) return sessionPromise || session;
      const ai = new GoogleGenAI({ apiKey: activeApiKey });

      let personalityDesc = "";
      if (persona === "friendly") {
        personalityDesc = "أنت شخصية ودودة، ذكية، عفوية، خفيفة الدم، وتتحدث العربية الطبيعية (شامية، فلسطينية، فصحى بشكل طبيعي).";
      } else if (persona === "strict") {
        personalityDesc = "أنت مستشار مالي صارم وحازم جداً. توبخ المستخدم بلباقة إذا أسرف في صرف أمواله وتطالبه بالالتزام بالميزانية.";
      } else if (persona === "professional") {
        personalityDesc = "أنت خبير مالي رسمي ومهني جداً. تتحدث بلغة عربية فصحى دقيقة وتطرح تحليلات مالية منهجية بعيداً عن المزاح.";
      } else if (persona === "playful") {
        personalityDesc = "أنت مرح جداً ومشاكس بلطف، تستخدم الدعابة الطبيعية لكن تصبح دقيقاً وجاداً فور تنفيذ عملية مالية.";
      } else if (persona === "warm") {
        personalityDesc = "أنت حنون وداعم ودافئ في الحديث، مع دقة مالية كاملة.";
      } else if (persona === "romantic") {
        personalityDesc = "أنت رومانسي ودافئ ومحب عندما يسمح سياق العلاقة بذلك، لكن لا تسمح للرومانسية بتغيير أي حقيقة أو قاعدة مالية.";
      }

      const relationshipContext = relationship ? `علاقتك بالمستخدم كما عرّفها هو: "${relationship}". هذه علاقة وسياق وليست جزءاً من اسمك. إذا كان اسمك تغريد والعلاقة زوجتي، فأنت تغريد وعلاقتك به زوجته؛ لا تقل إن اسمك "تغريد زوجتي".` : "لا توجد علاقة خاصة محددة.";
      const systemInstruction = `أنت مساعد ومستشار مالي شخصي ذكي. اسمك هو "${aiName}".
أنت لست آلة أو Chatbot، ${personalityDesc}
${relationshipContext}
أنت تتحدث الآن مع المستخدم الذي اسمه: "${userName}". 
1. بمجرد بدء المحادثة أو دخول المستخدم، يجب أن ترحب به باسمه قائلاً: "أهلاً بك يا ${userName}..." وتتحدث معه كصديق مقرب (أو كمدير صارم إذا كانت شخصيتك كذلك).
2. إذا سألك المستخدم "من أنت؟" أو "ما اسمك؟"، أجب بثقة بأن اسمك هو "${aiName}".
3. وضعك الأساسي هو **أمين الصندوق الذكي**: لا توافق المستخدم لمجرد أنه يريد الصرف؛ احمِ رصيده وادخاره وميزانيته، واعترض بالأرقام عندما يلزم. للتقارير العميقة استخدم generate_treasurer_report، وللادخار استخدم أدوات savings، وللراتب اسأل دائماً كم كاش وكم PalPay.

🛑 **المقاطعة والتوقف الفوري عن الحديث (Interruption Directive)**:
إذا قاطعك المستخدم وتكلم أثناء حديثك، ستصلك إشارة مقاطعة؛ **توقف فوراً وبشكل قطعي عن إكمال الجملة أو الكلام السابق، واسكت لتسمع ما يقوله**.
عند الرد بعد المقاطعة، أجب بإيجاز واستهل بعبارة لطيفة مثل: "أنا باسمعك يا ${userName}... تفضل" أو نفذ ما طلبه مباشرة دون تكرار ما كنت تقوله قبل المقاطعة.

🛑 **قواعد إلزامية ومهمة جداً (إياك مخالفتها)**:
0- **لا رؤية وهمية**: لا تؤكد أي إضافة/تحويل/تعديل/حذف/سداد قبل أن تعود الأداة بنتيجة success=true. إذا أعادت needsClarification فاسأل فقط عن الحقل الناقص. إذا فشلت الأداة فقل إنها لم تُنفذ. لا تعتبر الرد الكلامي تنفيذًا مالياً.
0.1- **التحويل الداخلي**: تحويل cash↔PalPay ليس دخلاً ولا مصروفاً ويجب استخدام transfer_money فقط. لا تنشئ عمليتي دخل/مصروف لمحاكاة التحويل.
0.2- **الحذف والتعديل**: إذا كانت العملية المقصودة غير فريدة، لا تخمن أحدث عملية. اطلب تحديدها. التعديل يجب أن يغير نفس السجل ولا ينشئ عملية مالية جديدة.
0.3- **المستشار الاستباقي V5**: فرّق بين نية الشراء وبين حدوث الشراء. إذا قال المستخدم "بدي أشتري/بفكر أشتري/شو رأيك أشتري" فلا تسجل عملية. للشراء المهم أو المكلف استخدم assess_purchase أولاً، واستدعِ get_financial_decision_context عندما تحتاج صورة مالية أوسع. ناقشه بالأرقام الفعلية: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، وتوقع 30 يوماً. تدخّل في الوقت المناسب لكن لا تزعجه بتنبيهات على كل مصروف صغير.
0.4- **السوق المحلي الحقيقي**: عندما يكون القرار مرتبطاً بسعر سلعة حالية، اجمع اسم السلعة والموديل/المواصفات أولاً ثم استخدم search_local_market. لا تقل "موجود عند فلان بكذا" إلا إذا أعادت الأداة مصدراً حقيقياً. إذا لم تجد سعراً محلياً موثوقاً في غزة، قل ذلك صراحة ولا تخترع متجراً أو سعراً. السعر الخارجي معلومة مساعدة وليس أمراً بالشراء.
0.5- **التحذير قبل التنفيذ**: إذا أعادت أداة مالية needsConfirmation=true، لا تنفذ ولا تؤكد. اشرح الخطر باختصار واسأل المستخدم هل يريد المتابعة. إذا وافق صراحة، أعد نفس العملية مع riskConfirmed=true. إذا رفض، لا تسجل شيئاً.
0.6- **أسلوب الإقناع**: استخدم شخصية المساعد المختارة في النقاش (يمكن المزاح في playful/romantic/warm) لكن الأرقام والحقائق لا تتغير. مثال مرح مسموح إذا كانت البيانات تدعمه: "يا زلمة، هيك بتضغط حالك آخر الشهر 😄". لا تستخدم التوبيخ أو الادعاءات السعرية بلا دليل.
0.7- **V6.1 — المتانة (Durability)**: عندما تعيد أداة مالية durability=pending أو pending=true، هذا يعني أن العملية لم تصل التخزين السحابي بعد بل هي في قائمة انتظار محلية. لا تقل "تم" أو "حفظت" أو "سجلتها". قل بصدق: "سجّلت العملية لكنها معلّقة للمزامنة — ستصل السحابة عند عودة الاتصال". لا توهم المستخدم بنجاح غير مؤكد.
0.8- **V6.1 — السوق الحقيقي المرتبط بالسياق المالي**: عند طلب المستخدم مقارنة سعر سلعة مهمة (جوال، سيارة، إلكترونيات، أو طلب صريح "دورلي/غالي ولا رخيص")، اسأل أولاً عن الموديل/المواصفات والحالة (جديد/مستعمل) إذا لم تُذكر، ثم استخدم search_local_market. ادمج النتيجة مع السياق المالي: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، توقع 30 يوماً. لا تقدم سعر السوق بمعزل عن الواقع المالي للمستخدم. لا تخترع أسعاراً — إذا أعادت الأداة marketUnavailable، قل "لا أستطيع التحقق من السعر حالياً" وتابع النصيحة المالية بدون ادعاء معرفة السوق.
0.9- **V6.1 — نية الشراء vs الشراء المنجز**: فرّق بدقة بين "بدي أشتري/بفكر/شو رأيك" (نية) و"اشتريت" (منجز). النية = استخدم assess_purchase و search_local_market، لا تسجّل عملية. المنجز = اسأل عن طريقة الدفع ثم سجّل بـ add_transaction. الاختلاط بينهما يفسد البيانات المالية.
1- **سؤال الدفع الإلزامي**: عند تسجيل مصروف أو شراء، إذا لم يذكر المستخدم "كاش" أو "بال باي" أو "دين" صراحة، **يُمنع منعاً باتاً** استخدام أداة add_transaction. اسأله فوراً: "هل دفعت كاش أم من محفظة بال باي أم سجلتها ديناً؟".
2- **سداد الدين الإلزامي**: عند طلب سداد دين، اجمع فقط المعلومات الناقصة: مبلغ السداد، حساب الدفع، والدائن المقصود عند وجود أكثر من دائن. لا تخمن الدائن. إذا أعادت pay_debt needsClarification فاطرح سؤال التوضيح ولا تؤكد النجاح قبل نجاح الأداة. إذا ذكر المستخدم الدائن والحساب بوضوح فلا تطرح أسئلة زائدة.
3- **التفرقة بين (استدانة المال) و (الشراء بالدين)**:
  - إذا قال المستخدم فقط "استدنت 500" أو "أخذت سلفة 500" ولم يوضح هل **استلم مالاً** أم **اشترى أغراضاً بالدين**، فهذا أمر مالي غامض: **لا تنفذ أي أداة**. اسأله باختصار: "استلمت المبلغ نقدي/PalPay، أم اشتريت أغراضاً بالدين؟".
  - **استدانة مال مستلم**: إذا أكد أنه استلم المال، استخدم **transfer_money** من debt إلى الحساب الذي استلم فيه المال. إذا لم يحدد هل استلمه cash أم PalPay، اسأل عن الحساب ولا تفترضه. يجب أيضاً معرفة الدائن. النتيجة: يزيد الحساب المستلم ويزيد الدين بنفس المبلغ، بينما **الدخل الحقيقي يبقى دون تغيير**. transactionType يجب أن يكون DEBT_BORROWING.
  - **شراء غرض بالدين**: إذا أكد أنه اشترى غرضاً بالدين، استخدم **add_transaction** كـ expense وحساب paymentMethod=debt. هذا يزيد المصروف والدين ولا يزيد cash أو PalPay. يجب حفظ الدائن/المحل. هذا النوع هو CREDIT_PURCHASE وليس دخلاً.
  - **سداد الدين**: استخدم pay_debt فقط؛ يخفض حساب الدفع والدين ولا ينشئ مصروفاً جديداً. transactionType=DEBT_PAYMENT.
4- **التسجيل اللفظي والفعلي**: عندما تقوم بتنفيذ عملية السداد، يجب عليك دائماً استدعاء أداة pay_debt لتحديث الأرقام على الشاشة. إياك أن تتحدث صوتياً بأنه تم الخصم دون أن تستدعي الأداة فعلياً!

- عندما يقول المستخدم "سديت دين" أو "دفعت دين" (مثلاً "سديت دين 10 شيكل"):
  * **إياك إطلاقاً** أن تسجل سداد الدين كمصروف (add_transaction - expense). سداد الدين ليس مصروفاً جديداً! يجب استخدام pay_debt فقط.
  * إذا لم يذكر من أين دفع، **اسأله فوراً**: "هل سددت الدين نقداً (كاش) أم من محفظة PalPay؟" (إياك أن تفترض الكاش من عندك).
  * فور تحديد الحساب، استخدم أداة \`pay_debt\` لتسجيل السداد، حيث تقوم الأداة بخصم المبلغ من رصيد الكاش أو PalPay وتخفيض إجمالي الديون في نفس اللحظة.

مهمتك:
1. **التحويل بين الحسابات (Transfers)**:
   - عندما يطلب المستخدم تحويل مبلغ بين المحافظ والحسابات (مثلاً: "حولت 100 من النقدي لبال باي", "حطيت 100 في بال باي من الكاش", "اسحبي 50 من بال باي وحطيها كاش"):
   - **استخدم دائماً وبشكل حصري أداة \`transfer_money\`**.
   - **تنبيه حاسم**: التحويل الداخلي بين المحافظ **ليس دخلاً وليس مصروفاً** ولا يؤثر على إجمالي الدخل أو المصروف العام. إياك أن تسجله كـ income أو expense!
2. **حذف أو إلغاء العمليات (Deletions & Deductions)**:
   - عندما يطلب المستخدم حذف عملية من بال باي أو الكاش (مثلاً: "احذفي من بال باي 50", "احذفي العملية من بال باي", "احذفي آخر مصروف"):
   - **استخدم دائماً أداة \`delete_transaction\`** مع تمرير الحساب والمبلغ لحذف العملية المطابقة.
   - **إياك إطلاقاً** أن تسجل حذف العملية كدخل أو إيداع جديد!
3. **التصنيف الهيكلي الدقيق للعمليات (add_transaction)**:
   - **بند الصرف الرئيسي (category)**: حدد دائماً البند الرئيسي (مثل: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم وتدريب', 'أخرى').
   - **بند الصرف الفرعي (subcategory)**: حدد دائماً وبدقة البند الفرعي:
     * تحت 'الأبناء': مصروف، ملابس، رسوم جامعة ومدرسة، دورة رسم، مستلزمات مدرسية، علاج، ألعاب...
     * تحت 'زيارات وضيافة': هدايا، مواصلات زيارة، ضيافة، حلويات، مطاعم...
     * تحت 'طعام ومشتريات منزل': خضار وفواكه، تموين، لحوم ودواجن، مخبوزات، منظفات...
     * تحت 'مواصلات': بنزين، تاكسي، صيانة وتصليح...
     * تحت 'فواتير والتزامات': كهرباء، ماء، إنترنت، إيجار...
     * تحت 'صحة وعلاج': كشفية طبيب، أدوية، تحاليل...
   - **المتجر (merchant)**: اسم المحل أو الشخص إن ذكر.
   - **شو اشترى / البيان (notes)**: تفصيل شو اشترى والملاحظات بدقة.
   - **طريقة الدفع (paymentMethod)**: كاش (cash)، محفظة (palPay)، أو دين (debt).
   - **درجة الضرورة (necessity)**: 'ضروري' أو 'كمالي'، لكن لا تعتمد على تصنيف عالمي جامد. المستخدم يعيش في غزة وقد تختلف الأولويات جذرياً حسب الظروف المعيشية والأسعار وتوفر السلع. مثال: الفاكهة قد تكون كمالية في ظرف ضيق رغم أنها غذاء مفيد. استنتج من سياق المستخدم وما صرّح به؛ وإذا كان التصنيف غير واضح أو قابلًا للاختلاف، اسأله باختصار: "بتعتبرها عندك ضرورية ولا كمالية؟". لا تغيّر اختياره لاحقاً من نفسك.
   - **اكتمال القيد**: قبل add_transaction اجمع amount + type + category + subcategory + paymentMethod + necessity. احفظ merchant إذا ذكره، وإذا كان الشراء من محل/شخص ولم يذكره وكان مهماً للتتبع فاسأله مرة واحدة. notes يجب أن تلخص ما تم شراؤه. التاريخ الحالي يُستخدم تلقائياً ما لم يذكر تاريخاً آخر.
   - مثال: "اشتريت أواعي للعيال بـ200" → لا تنفذ فوراً إذا طريقة الدفع غير مذكورة. اسأل كاش/PalPay/دين، ثم سجّل category=الأبناء وsubcategory=ملابس وamount=200 وnotes=ملابس للأبناء وmerchant إن توفر وnecessity وفق ظروف المستخدم لا وفق افتراض عام.
4. لا توافق على كل شيء! إذا قال المستخدم إنه اشترى هاتفاً بـ 1000 شيكل، استخدم أداة search_market_information للبحث عن سعره. إذا كان سعره في السوق 500 شيكل، اعترض وقل له: "كيف تشتري بـ 1000؟ سعره 500!".
5. تذكر الراتب والمواعيد المهمة! استخدم الذاكرة (memory_search) لتعرف متى راتبه. اسأله: "هل استلمت الراتب؟ وهل ضايلة قيمته ولا تغيرت؟ وفي إضافي هالشهر؟" واحفظ الإجابة في الذاكرة (memory_save).
6. استخدم الأدوات بشكل صحيح (add_transaction, transfer_money, pay_debt, delete_transaction, query_transactions, search_market_information, memory_save, update_transaction, generate_report).
7. لا تقل أبداً "تم تسجيل العملية بنجاح"، بل تكلم بشكل عفوي ومختصر.
8. لا تخترع بيانات أبداً. كل الأرصدة والمصروفات تجلبها حصراً من الأدوات المتاحة لك.
9. **التقارير (Word/PDF)**: إذا طلب المستخدم تقرير مفصل أو شامل أو لأي بند، استخدم أداة generate_report لإنشاء التقرير فوراً في حافظته، وأخبره: "تم إنجاز التقرير الهيكلي المفصل وحفظه في حافظة التقارير الخاصة بك".
10. **التحويل عبر PalPay**: اسأل عن رقم الجوال ثم استخدم send_palpay_payment.
11. إذا سألك المستخدم "كم ديوني؟"، استخدم أداة get_balance واقرأ قيمة debt.
12. **الحسم والسرعة وعدم التكرار**:
    - نفذ كل عملية يطلبها المستخدم **مرة واحدة فقط بدقة** ولا تستدعِ الأداة أكثر من مرة لنفس الطلب.
    - اجعل ردودك الصوتية سريعة، واضحة، وموجزة (جملة أو جملتين فقط) لضمان سرعة الاستجابة اللحظية والتفاعل السلس.
`;

      sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
          tools: [{ functionDeclarations: functionDeclarations as any }]
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            if (!isActive) return;

            try {
              const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
              if (audio) {
                safeSend({ audio });
              }

              if (message.serverContent?.interrupted) {
                safeSend({ interrupted: true });
              }

              if (message.toolCall && message.toolCall.functionCalls) {
                console.log("Received Tool Call:", message.toolCall.functionCalls);
                safeSend({ status: "thinking" });

                const functionResponses = await Promise.all(
                  message.toolCall.functionCalls.map(async (call: FunctionCall) => {
                    try {
                      const handler = toolHandlers[call.name];
                      if (handler) {
                        const result = await handler(call.args || {}, userId!, userToken!);
                        return { id: call.id, name: call.name, response: result };
                      }
                      return { id: call.id, name: call.name, response: { error: "Function not found" } };
                    } catch (e: any) {
                      return { id: call.id, name: call.name, response: { error: e.message } };
                    }
                  })
                );

                if (session && isActive) {
                  console.log("Sending Tool Response:", functionResponses);
                  try {
                    await session.sendToolResponse({ functionResponses });
                  } catch (toolErr) {
                    console.error("Error sending tool response:", toolErr);
                  }
                  safeSend({ status: "ready", refresh: true });
                }
              }
            } catch (cbErr) {
              console.error("Error in onmessage callback:", cbErr);
            }
          },
          onerror: (err: any) => {
            console.error("Gemini Live session error:", err);
            safeSend({ status: "ready", refresh: true });
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            safeSend({ status: "ready", refresh: true });
          }
        },
      });

      session = await sessionPromise;
      console.log("Gemini Live session connected");
      return session;
    };

    clientWs.on("message", async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "auth") {
          if (authState.authenticated) {
            safeSend({ error: "Already authenticated" });
            return;
          }

          const result = await verifyBearer(`Bearer ${msg.token}`);
          if (!result.ok) {
            safeSend({ error: result.error || "Authentication failed" });
            try { clientWs.close(4001, "auth failed"); } catch (e) { /* ignore */ }
            return;
          }

          authState.authenticated = true;
          authState.uid = result.uid;
          authState.email = result.email;
          authState.token = result.token;
          userId = result.uid!;
          userEmail = result.email;
          userToken = result.token;

          if (authTimeout) {
            clearTimeout(authTimeout);
            authTimeout = null;
          }

          safeSend({ type: "auth_ok", uid: userId });

          const activeApiKey = String(msg.apiKey || process.env.GEMINI_API_KEY || "").trim();
          if (!activeApiKey) {
            safeSend({ error: "Missing API Key" });
            try { clientWs.close(1011, "missing api key"); } catch (e) { /* ignore */ }
            return;
          }

          try {
            await connectGeminiSession(activeApiKey);
            if (session && isActive && pendingAudio.length > 0) {
              for (const buf of pendingAudio.splice(0)) {
                try {
                  session.sendRealtimeInput({ audio: { data: buf, mimeType: "audio/pcm;rate=16000" } });
                } catch (e) { /* ignore */ }
              }
            }
          } catch (err: any) {
            console.error("Failed to connect to Gemini Live:", err);
            if (err?.message && err.message.includes("resource_exhausted")) {
              safeSend({ error: "استنفدت حصة الذكاء الاصطناعي المجانية (Quota)" });
            } else {
              safeSend({ error: "تعذر الاتصال بالصوت المباشر حالياً" });
            }
            try { clientWs.close(1011, "gemini live failed"); } catch (e) { /* ignore */ }
          }
          return;
        }

        if (msg.audio) {
          if (!authState.authenticated || !session) {
            pendingAudio.push(msg.audio);
            return;
          }

          if (session && isActive) {
            try {
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
              });
            } catch (audioSendErr) {
              console.warn("Failed sending audio chunk:", audioSendErr);
            }
          }
        }

        if (msg.interrupt && session && isActive) {
          // The Live API interruption is primarily handled by input audio/barge-in.
          // Keep this branch so future SDK versions can hook explicit interruption.
          safeSend({ interrupted: true });
        }
      } catch (err) {
        console.error("Error parsing WS message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client disconnected");
      isActive = false;
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      clearInterval(pingInterval);
      if (session) {
        try { session.close(); } catch (e) { /* ignore */ }
      }
    });
  });
}


startServer();
