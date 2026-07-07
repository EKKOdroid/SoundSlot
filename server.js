const http = require("http");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const { calculatePaywallAmount } = require("./paywall");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "data.json");
const APP_VERSION = "1.3.0";
const APP_BASE_URL = process.env.APP_BASE_URL || "";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_CLIENT = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readData() {
  try {
    return {
      instruments: ["DJ", "Drums", "Guitar", "Piano", "Singing", "Violin"],
      teachers: [],
      users: [],
      bookings: [],
      ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    };
  } catch {
    return {
      instruments: ["DJ", "Drums", "Guitar", "Piano", "Singing", "Violin"],
      teachers: [],
      users: [],
      bookings: []
    };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function sortedUniqueInstruments(items) {
  return [...new Set(items.map(item => String(item).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function appUrl(pathname, params = {}) {
  const base = APP_BASE_URL || `http://localhost:${PORT}`;
  const url = new URL(pathname, base.replace(/\/$/, "") + "/");
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function checkoutBaseUrl() {
  const base = (APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
  return base || `http://localhost:${PORT}`;
}

function checkoutRedirectUrl(kind, recordId, email, checkoutState = "success") {
  const url = new URL(`${checkoutBaseUrl()}/`);
  url.searchParams.set("checkout", checkoutState);
  url.searchParams.set("kind", kind);
  if (recordId) {
    url.searchParams.set("recordId", recordId);
  }
  if (email) {
    url.searchParams.set("email", email);
  }
  return url.toString();
}

function finalizeCheckoutRecord(data, kind, recordId, session) {
  const paidAt = new Date().toISOString();
  const amountPaid = Number(session?.amount_total || 0) / 100;

  if (kind === "booking") {
    const booking = (data.bookings || []).find(item => String(item.id) === String(recordId));
    if (booking) {
      booking.status = "paid";
      booking.paidAt = paidAt;
      booking.paymentSessionId = session?.id || "";
      booking.totalAmount = amountPaid;
      booking.updatedAt = paidAt;
    }
  }

  if (kind === "teacher") {
    const teacher = (data.teachers || []).find(item => String(item.id) === String(recordId));
    if (teacher) {
      teacher.status = "paid";
      teacher.paidAt = paidAt;
      teacher.paymentSessionId = session?.id || "";
      teacher.totalAmount = amountPaid;
      teacher.updatedAt = paidAt;
    }
  }

  return data;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safePath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.join(ROOT, cleanPath);
  return filePath.startsWith(ROOT) ? filePath : null;
}

function byNewest(items, key = "createdAt") {
  return [...items].sort((a, b) => new Date(b[key] || 0) - new Date(a[key] || 0));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      app: "SoundSlot",
      version: APP_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (url.pathname === "/api/instruments" && request.method === "GET") {
    const data = readData();
    data.instruments = sortedUniqueInstruments(data.instruments || []);
    sendJson(response, 200, { instruments: data.instruments });
    return;
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    const data = readData();
    const users = (data.users || []).map(({ password, ...user }) => user);
    sendJson(response, 200, { users });
    return;
  }

  if (url.pathname === "/api/users" && request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "").trim();
      if (!name || !email || !password) {
        sendJson(response, 400, { error: "Name, email, and password are required" });
        return;
      }

      const data = readData();
      const existing = (data.users || []).find(user => user.email.toLowerCase() === email);
      if (existing && existing.id !== body.id) {
        sendJson(response, 409, { error: "An account with this email already exists" });
        return;
      }

      const user = {
        id: body.id || `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        email,
        password,
        role: "student",
        phone: body.phone || "",
        createdAt: body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      data.users = [...(data.users || []).filter(item => item.id !== user.id), user];
      writeData(data);
      const { password: _password, ...safeUser } = user;
      sendJson(response, 201, { user: safeUser, users: data.users.map(({ password, ...item }) => item) });
    } catch {
      sendJson(response, 400, { error: "Invalid user account request" });
    }
    return;
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "").trim();
      const data = readData();
      const user = (data.users || []).find(item => item.email.toLowerCase() === email && item.password === password);
      if (!user) {
        sendJson(response, 401, { error: "Email or password is incorrect" });
        return;
      }
      user.lastLoginAt = new Date().toISOString();
      user.updatedAt = new Date().toISOString();
      writeData(data);
      const { password: _password, ...safeUser } = user;
      sendJson(response, 200, { user: safeUser });
    } catch {
      sendJson(response, 400, { error: "Invalid login request" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/users/") && request.method === "DELETE") {
    try {
      const userId = decodeURIComponent(url.pathname.split("/").pop());
      const data = readData();
      const existing = (data.users || []).find(item => String(item.id) === userId);
      if (!existing) {
        sendJson(response, 404, { error: "User account not found" });
        return;
      }

      data.users = (data.users || []).filter(item => String(item.id) !== userId);
      data.bookings = (data.bookings || []).map(booking => {
        if (String(booking.userId) !== userId || ["cancelled", "declined", "paid"].includes(booking.status)) {
          return booking;
        }
        return {
          ...booking,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cancellationReason: "User account deleted"
        };
      });
      writeData(data);
      sendJson(response, 200, {
        deletedUserId: userId,
        users: data.users.map(({ password, ...user }) => user),
        bookings: data.bookings
      });
    } catch {
      sendJson(response, 400, { error: "Invalid user delete request" });
    }
    return;
  }

  if (url.pathname === "/api/instruments" && request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const instrument = String(body.instrument || "").trim();
      if (!instrument) {
        sendJson(response, 400, { error: "Instrument is required" });
        return;
      }

      const data = readData();
      data.instruments = sortedUniqueInstruments([...(data.instruments || []), instrument]);
      writeData(data);
      sendJson(response, 201, { instruments: data.instruments });
    } catch {
      sendJson(response, 400, { error: "Invalid instrument request" });
    }
    return;
  }

  if (url.pathname === "/api/teachers" && request.method === "GET") {
    const data = readData();
    sendJson(response, 200, { teachers: data.teachers || [] });
    return;
  }

  if (url.pathname === "/api/teachers" && request.method === "POST") {
    try {
      const profile = JSON.parse(await readRequestBody(request));
      if (!profile.name || !profile.email || !Array.isArray(profile.instruments) || profile.instruments.length === 0) {
        sendJson(response, 400, { error: "Teacher name, email, and instruments are required" });
        return;
      }

      const data = readData();
      const teacher = {
        ...profile,
        id: profile.id || `teacher-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        instrument: profile.instruments[0],
        instruments: sortedUniqueInstruments(profile.instruments),
        rating: Number(profile.rating || 0),
        reviews: Number(profile.reviews || 0),
        likes: Number(profile.likes || 0),
        reviewsList: profile.reviewsList || [],
        createdAt: profile.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      data.teachers = [...(data.teachers || []).filter(item => item.id !== teacher.id), teacher];
      data.instruments = sortedUniqueInstruments([...(data.instruments || []), ...teacher.instruments]);
      writeData(data);
      sendJson(response, 201, { teacher, teachers: data.teachers });
    } catch {
      sendJson(response, 400, { error: "Invalid teacher profile" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/teachers/") && request.method === "DELETE") {
    try {
      const teacherId = decodeURIComponent(url.pathname.split("/").pop());
      const data = readData();
      const existing = (data.teachers || []).find(item => String(item.id) === teacherId);
      if (!existing) {
        sendJson(response, 404, { error: "Teacher profile not found" });
        return;
      }

      data.teachers = (data.teachers || []).filter(item => String(item.id) !== teacherId);
      data.bookings = (data.bookings || []).map(booking => {
        if (String(booking.teacherId) !== teacherId || ["cancelled", "declined", "paid"].includes(booking.status)) {
          return booking;
        }
        return {
          ...booking,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cancellationReason: "Instructor profile deleted"
        };
      });
      writeData(data);
      sendJson(response, 200, { deletedTeacherId: teacherId, teachers: data.teachers, bookings: data.bookings });
    } catch {
      sendJson(response, 400, { error: "Invalid teacher delete request" });
    }
    return;
  }

  if (url.pathname === "/api/bookings" && request.method === "GET") {
    const data = readData();
    sendJson(response, 200, { bookings: data.bookings || [] });
    return;
  }

  if (url.pathname === "/api/bookings" && request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      if (!body.teacherId || !(body.studentEmail || body.email) || !body.slotId) {
        sendJson(response, 400, { error: "Teacher, student email, and slot are required" });
        return;
      }

      const data = readData();
      const studentEmail = String(body.studentEmail || body.email || "").trim().toLowerCase();
      const user = (data.users || []).find(item => item.email.toLowerCase() === studentEmail);
      const booking = {
        ...body,
        id: body.id || `booking-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId: body.userId || user?.id || "",
        studentEmail,
        email: studentEmail,
        status: body.status || "pending",
        requestedAt: body.requestedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      data.bookings = [...(data.bookings || []).filter(item => item.id !== booking.id), booking];
      writeData(data);
      sendJson(response, 201, { booking, bookings: data.bookings });
    } catch {
      sendJson(response, 400, { error: "Invalid booking request" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/bookings/") && request.method === "PATCH") {
    try {
      const bookingId = decodeURIComponent(url.pathname.split("/").pop());
      const body = JSON.parse(await readRequestBody(request));
      const data = readData();
      const booking = (data.bookings || []).find(item => item.id === bookingId);
      if (!booking) {
        sendJson(response, 404, { error: "Booking not found" });
        return;
      }

      Object.assign(booking, body, { updatedAt: new Date().toISOString() });
      writeData(data);
      sendJson(response, 200, { booking, bookings: data.bookings });
    } catch {
      sendJson(response, 400, { error: "Invalid booking update" });
    }
    return;
  }

  if (url.pathname === "/api/paywall/checkout" && request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const amount = Number(body.amount || 0);
      const currency = String(body.currency || "eur").toLowerCase();
      const kind = String(body.kind || "booking").toLowerCase();
      const recordId = String(body.recordId || "").trim();
      const email = String(body.metadata?.email || "").trim();
      const totalCents = calculatePaywallAmount(amount);
      const successUrl = String(body.successUrl || checkoutRedirectUrl(kind, recordId, email, "success"));
      const cancelUrl = String(body.cancelUrl || checkoutRedirectUrl(kind, recordId, email, "cancelled"));

      if (!STRIPE_CLIENT) {
        sendJson(response, 200, {
          ok: true,
          mock: true,
          url: `${checkoutBaseUrl()}/?checkout=success&kind=${encodeURIComponent(kind)}&recordId=${encodeURIComponent(recordId)}`,
          amount: totalCents / 100,
          fee: totalCents / 100 - amount
        });
        return;
      }

      const session = await STRIPE_CLIENT.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency,
            unit_amount: totalCents,
            product_data: {
              name: kind === "teacher" ? "SoundSlot teacher profile activation" : "SoundSlot lesson booking"
            }
          },
          quantity: 1
        }],
        customer_email: email || undefined,
        metadata: {
          kind,
          recordId,
          ...(body.metadata || {})
        },
        success_url: successUrl,
        cancel_url: cancelUrl
      });

      sendJson(response, 200, {
        ok: true,
        sessionId: session.id,
        url: session.url,
        amount: totalCents / 100,
        fee: totalCents / 100 - amount
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to create checkout session" });
    }
    return;
  }

  if (url.pathname === "/api/paywall/complete" && request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const sessionId = String(body.sessionId || "").trim();
      const kind = String(body.kind || "booking").toLowerCase();
      const recordId = String(body.recordId || "").trim();
      if (!sessionId && !recordId) {
        sendJson(response, 400, { error: "Missing payment session data" });
        return;
      }

      if (!STRIPE_CLIENT) {
        const data = readData();
        finalizeCheckoutRecord(data, kind, recordId, { id: sessionId, amount_total: Math.round(Number(body.amount || 0) * 100) });
        writeData(data);
        sendJson(response, 200, { ok: true, completed: true, mock: true });
        return;
      }

      const session = await STRIPE_CLIENT.checkout.sessions.retrieve(sessionId);
      if (!session || session.payment_status !== "paid") {
        sendJson(response, 402, { error: "Payment not yet confirmed" });
        return;
      }

      const data = readData();
      finalizeCheckoutRecord(data, kind, recordId, session);
      writeData(data);
      sendJson(response, 200, { ok: true, completed: true, session });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Unable to finalize checkout" });
    }
    return;
  }

  const filePath = safePath(url.pathname);
  if (!filePath) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(ROOT, "index.html"), (fallbackError, fallbackContent) => {
        if (fallbackError) {
          sendJson(response, 404, { error: "Not found" });
          return;
        }
        response.writeHead(200, { "Content-Type": types[".html"] });
        response.end(fallbackContent);
      });
      return;
    }

    const extension = path.extname(filePath);
    response.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream" });
    response.end(content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SoundSlot running on http://${HOST}:${PORT}`);
  console.log(`SoundSlot also available at http://localhost:${PORT}`);
});
