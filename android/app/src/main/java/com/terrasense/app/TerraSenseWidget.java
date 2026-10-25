package com.terrasense.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * TerraSense home-screen widget.
 *  - Shows readings, the plant cycle and what the hub is doing for one greenhouse.
 *  - ‹ › switch greenhouse. The device buttons, Auto/Manual and Stop work right from the widget
 *    (no need to open the app). Tapping the leaf opens the app.
 *  - Resizable: it shows more sections the taller it is made.
 */
public class TerraSenseWidget extends AppWidgetProvider {
    private static final String PREFS = "terrasense_widget";
    private static final String ACTION_PREV = "com.terrasense.app.WIDGET_PREV";
    private static final String ACTION_NEXT = "com.terrasense.app.WIDGET_NEXT";
    private static final String ACTION_TOGGLE = "com.terrasense.app.WIDGET_TOGGLE";

    /** Button id -> control key in the database. */
    private static final int[] DEVICE_IDS = {R.id.act_water, R.id.act_cool, R.id.act_heat, R.id.act_humid, R.id.act_light, R.id.act_fert};
    private static final String[] DEVICE_KEYS = {"pump", "cooler", "heater", "humidifier", "lights", "fertilizer"};

    // ---------------------------------------------------------------- data from the app

    /** Called by the plugin whenever the app has fresh data. */
    static void store(Context ctx, String json) {
        try {
            JSONObject o = new JSONObject(json);
            SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
            if (!o.optBoolean("hasHub", false)) {
                e.clear();
            } else {
                String id = o.optString("id");
                JSONObject fb = o.optJSONObject("fb");
                if (fb != null) {
                    o.remove("fb");              // keep the login details out of the per-greenhouse snapshot
                    e.putString("fb", fb.toString());
                }
                e.putString("gh_" + id, o.toString());
                e.putString("list", o.optJSONArray("list") != null ? o.getJSONArray("list").toString() : "[]");
                e.putString("selected", id);
            }
            e.apply();
        } catch (Exception ignored) { }
        refreshAll(ctx);
    }

    // ---------------------------------------------------------------- provider callbacks

    static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TerraSenseWidget.class));
        for (int id : ids) mgr.updateAppWidget(id, build(ctx, mgr.getAppWidgetOptions(id)));
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(ctx, mgr.getAppWidgetOptions(id)));
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle newOptions) {
        mgr.updateAppWidget(id, build(ctx, newOptions));   // resized: show or hide sections
    }

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String a = intent.getAction();
        if (ACTION_PREV.equals(a) || ACTION_NEXT.equals(a)) {
            shift(ctx, ACTION_NEXT.equals(a) ? 1 : -1);
            refreshAll(ctx);
        } else if (ACTION_TOGGLE.equals(a)) {
            final String key = intent.getStringExtra("key");
            if (key == null) return;
            final PendingResult pr = goAsync();
            new Thread(new Runnable() {
                @Override public void run() {
                    try { toggle(ctx, key); } finally { pr.finish(); }
                }
            }).start();
        }
    }

    private static void shift(Context ctx, int dir) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray list = new JSONArray(p.getString("list", "[]"));
            if (list.length() < 2) return;
            String cur = p.getString("selected", "");
            int idx = 0;
            for (int i = 0; i < list.length(); i++) if (list.getJSONObject(i).optString("id").equals(cur)) idx = i;
            idx = (idx + dir + list.length()) % list.length();
            p.edit().putString("selected", list.getJSONObject(idx).optString("id")).apply();
        } catch (Exception ignored) { }
    }

    // ---------------------------------------------------------------- switching devices from the widget

    private static void toast(final Context ctx, final String msg) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show(); }
        });
    }

    private static void toggle(Context ctx, String key) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sel = p.getString("selected", "");
        String raw = p.getString("gh_" + sel, null);
        String fbRaw = p.getString("fb", null);
        if (raw == null || fbRaw == null) { toast(ctx, "Open TerraSense once to finish setting up the widget"); return; }

        boolean device = !key.equals("manual") && !key.equals("emergencyStop");
        boolean cur, next;
        try {
            JSONObject o = new JSONObject(raw);
            JSONObject ctl = o.optJSONObject("ctl");
            if (ctl == null) ctl = new JSONObject();
            if (!o.optBoolean("online", false)) { toast(ctx, "Hub is offline"); return; }
            if (device && ctl.optBoolean("emergencyStop")) { toast(ctx, "Emergency stop is on. Resume it in the app."); return; }
            if (device && !ctl.optBoolean("manual")) { toast(ctx, "Switch to Manual mode in the app first"); return; }
            cur = ctl.optBoolean(key);
            next = !cur;

            // Show the change immediately; it is undone below if the write fails
            applyLocal(p, sel, key, next);
            refreshAll(ctx);

            if (!writeControl(ctx, p, fbRaw, sel, key, next)) {
                applyLocal(p, sel, key, cur);
                refreshAll(ctx);
                toast(ctx, "Couldn't reach TerraSense. Check your connection.");
            }
        } catch (Exception e) {
            toast(ctx, "Couldn't update the device");
        }
    }

    /** Updates the saved snapshot so the widget reflects a change before the app sends fresh data. */
    private static void applyLocal(SharedPreferences p, String sel, String key, boolean value) {
        try {
            JSONObject o = new JSONObject(p.getString("gh_" + sel, "{}"));
            JSONObject ctl = o.optJSONObject("ctl");
            if (ctl == null) ctl = new JSONObject();
            ctl.put(key, value);
            o.put("ctl", ctl);

            JSONObject acts = o.optJSONObject("acts");
            if (acts == null) acts = new JSONObject();
            if (key.equals("emergencyStop")) {
                if (value) { for (String k : DEVICE_KEYS) acts.put(k, false); o.put("action", "Emergency stop"); }
                else { o.put("action", "Resuming…"); }
            } else if (!key.equals("manual")) {
                acts.put(key, value);
            }
            o.put("acts", acts);
            p.edit().putString("gh_" + sel, o.toString()).apply();
        } catch (Exception ignored) { }
    }

    private static boolean writeControl(Context ctx, SharedPreferences p, String fbRaw, String id, String key, boolean value) {
        try {
            JSONObject fb = new JSONObject(fbRaw);
            String token = idToken(p, fb);
            if (token == null) return false;
            String url = fb.getString("dbUrl").replaceAll("/+$", "") + "/greenhouses/" + id + "/controls/" + key + ".json?auth=" + Uri.encode(token);
            int code = http("PUT", url, value ? "true" : "false", "application/json").code;
            return code >= 200 && code < 300;
        } catch (Exception e) {
            return false;
        }
    }

    /** Returns a valid login token, refreshing it with the saved refresh token when it is about to expire. */
    private static String idToken(SharedPreferences p, JSONObject fb) {
        try {
            String cached = p.getString("idToken", null);
            if (cached != null && System.currentTimeMillis() < p.getLong("idExp", 0) - 60000) return cached;

            String body = "grant_type=refresh_token&refresh_token=" + Uri.encode(fb.getString("refreshToken"));
            Http r = http("POST", "https://securetoken.googleapis.com/v1/token?key=" + Uri.encode(fb.getString("apiKey")), body, "application/x-www-form-urlencoded");
            if (r.code != 200) return null;
            JSONObject j = new JSONObject(r.body);
            String token = j.getString("id_token");
            long expires = Long.parseLong(j.optString("expires_in", "3600")) * 1000L;
            p.edit().putString("idToken", token).putLong("idExp", System.currentTimeMillis() + expires).apply();
            return token;
        } catch (Exception e) {
            return null;
        }
    }

    private static class Http { int code; String body = ""; }

    private static Http http(String method, String url, String body, String contentType) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", contentType);
        OutputStream os = c.getOutputStream();
        os.write(body.getBytes(StandardCharsets.UTF_8));
        os.close();
        Http r = new Http();
        r.code = c.getResponseCode();
        InputStream is = r.code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (is != null) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            r.body = bos.toString("UTF-8");
            is.close();
        }
        c.disconnect();
        return r;
    }

    // ---------------------------------------------------------------- drawing

    private static PendingIntent broadcast(Context ctx, String action, int code) {
        Intent i = new Intent(ctx, TerraSenseWidget.class).setAction(action);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent toggleIntent(Context ctx, String key, int code) {
        Intent i = new Intent(ctx, TerraSenseWidget.class).setAction(ACTION_TOGGLE);
        i.setData(Uri.parse("terrasense://toggle/" + key));     // makes each button's intent unique
        i.putExtra("key", key);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String fmt(JSONObject o, String key, String unit, boolean whole) {
        if (o == null || o.isNull(key) || !o.has(key)) return "—";
        double v = o.optDouble(key);
        if (Double.isNaN(v)) return "—";
        return (whole ? String.valueOf(Math.round(v)) : String.format(Locale.US, "%.1f", v)) + unit;
    }

    // Dim indoor light is often under 10 lx, so keep decimals there instead of rounding to 0
    private static String lux(JSONObject o) {
        if (o == null || o.isNull("lux") || !o.has("lux")) return "—";
        double v = o.optDouble("lux");
        if (Double.isNaN(v)) return "—";
        if (v >= 100) return String.valueOf(Math.round(v));
        if (v >= 10) return String.format(Locale.US, "%.1f", v);
        return String.format(Locale.US, "%.2f", v);
    }

    private static void setLit(RemoteViews v, int id, boolean on) {
        v.setFloat(id, "setAlpha", on ? 1f : 0.35f);
        v.setInt(id, "setBackgroundResource", on ? R.drawable.widget_pill_active : R.drawable.widget_pill);
    }

    /** Fills one level bar (water tank / fertilizer). Turns amber under 20 %. */
    private static void setLevel(RemoteViews v, JSONObject o, String key, int valId, int barId) {
        if (o.isNull(key) || !o.has(key) || Double.isNaN(o.optDouble(key))) {
            v.setTextViewText(valId, "—");
            v.setTextColor(valId, 0xFFFFFFFF);
            v.setProgressBar(barId, 100, 0, false);
            return;
        }
        int pct = (int) Math.max(0, Math.min(100, Math.round(o.optDouble(key))));
        v.setTextViewText(valId, pct + "%");
        v.setTextColor(valId, pct < 20 ? 0xFFFFB74D : 0xFFFFFFFF);
        v.setProgressBar(barId, 100, pct, false);
    }

    private static boolean has(JSONObject o, String key) {
        return o.has(key) && !o.isNull(key) && !Double.isNaN(o.optDouble(key));
    }

    static RemoteViews build(Context ctx, Bundle options) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.terrasense_widget);
        float d = ctx.getResources().getDisplayMetrics().density;

        // Real size of the widget in dp. In portrait the launcher reports the width as MIN_WIDTH and the
        // height as MAX_HEIGHT (landscape is the other way round). Reading MIN_HEIGHT in portrait makes the
        // widget think it is shorter than it is, which is what left empty space at the bottom.
        boolean land = ctx.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        int w = 250, h = 250;
        if (options != null) {
            int ow = options.getInt(land ? AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH : AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
            int oh = options.getInt(land ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
            if (ow > 0) w = ow;
            if (oh > 0) h = oh;
        }
        boolean compact = h < 130;                       // 3x2: header + readings only

        int pad = Math.round((compact ? 8 : 10) * d);
        v.setViewPadding(R.id.widget_root, pad, pad, pad, pad);
        v.setViewPadding(R.id.widget_body, 0, Math.round((compact ? 6 : 8) * d), 0, 0);

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) {
            v.setOnClickPendingIntent(R.id.widget_badge,
                PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        v.setOnClickPendingIntent(R.id.widget_prev, broadcast(ctx, ACTION_PREV, 1));
        v.setOnClickPendingIntent(R.id.widget_next, broadcast(ctx, ACTION_NEXT, 2));
        for (int i = 0; i < DEVICE_IDS.length; i++) {
            v.setOnClickPendingIntent(DEVICE_IDS[i], toggleIntent(ctx, DEVICE_KEYS[i], 10 + i));
        }

        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sel = p.getString("selected", "");
        String raw = sel.isEmpty() ? null : p.getString("gh_" + sel, null);
        if (raw == null) {
            v.setTextViewText(R.id.widget_name, "TerraSense");
            v.setTextViewText(R.id.widget_status, "Tap the leaf to open the app");
            v.setViewVisibility(R.id.widget_body, View.GONE);
            v.setTextViewText(R.id.widget_dots, "");
            v.setViewVisibility(R.id.widget_prev, View.GONE);
            v.setViewVisibility(R.id.widget_next, View.GONE);
            return v;
        }

        try {
            JSONObject o = new JSONObject(raw);
            JSONArray list = new JSONArray(p.getString("list", "[]"));
            boolean multi = list.length() > 1;
            v.setViewVisibility(R.id.widget_prev, multi ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.widget_next, multi ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.widget_body, View.VISIBLE);

            JSONArray notes = o.optJSONArray("notes");
            int noteCount = notes != null ? notes.length() : 0;

            boolean online = o.optBoolean("online", false);
            v.setTextViewText(R.id.widget_name, o.optString("name", "Greenhouse"));
            String when = new SimpleDateFormat("h:mm a", Locale.getDefault()).format(new Date(o.optLong("ts", System.currentTimeMillis())));
            String status = (online ? "● Online" : "● Offline") + " · " + when;
            if (noteCount > 0) status += " · ⚠ " + noteCount;       // visible even when the widget is too small for the status strip
            v.setTextViewText(R.id.widget_status, status);
            v.setTextColor(R.id.widget_status, !online || noteCount > 0 ? 0xFFFFB74D : 0xFF9CE37D);

            // Page dots: which greenhouse is showing (hidden when the widget is narrow)
            StringBuilder dots = new StringBuilder();
            if (multi && w >= 230) {
                String sel2 = o.optString("id");
                for (int i = 0; i < list.length() && i < 6; i++) {
                    dots.append(list.getJSONObject(i).optString("id").equals(sel2) ? "●" : "○");
                    if (i < list.length() - 1 && i < 5) dots.append(" ");
                }
            }
            v.setTextViewText(R.id.widget_dots, dots.toString());

            // Readings: icons are dropped at the smallest size; numbers grow when there is room
            float valueSize = compact ? 16f : (h >= 245 ? 20f : 18f);
            int[] valueIds = {R.id.widget_temp, R.id.widget_hum, R.id.widget_soil, R.id.widget_lux};
            for (int id : valueIds) v.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, valueSize);
            int iconVis = compact ? View.GONE : View.VISIBLE;
            v.setViewVisibility(R.id.ic_temp, iconVis);
            v.setViewVisibility(R.id.ic_hum, iconVis);
            v.setViewVisibility(R.id.ic_soil, iconVis);
            v.setViewVisibility(R.id.ic_lux, iconVis);

            v.setTextViewText(R.id.widget_temp, fmt(o, "temp", "°", false));
            v.setTextViewText(R.id.widget_hum, fmt(o, "hum", "%", true));
            v.setTextViewText(R.id.widget_soil, fmt(o, "soil", "%", true));
            v.setTextViewText(R.id.widget_lux, lux(o));

            // Status strip: what the hub is doing + the top alert
            v.setTextViewText(R.id.widget_action, o.optString("action", ""));
            if (noteCount > 0) {
                String alert = "⚠ " + notes.optString(0) + (noteCount > 1 ? "  +" + (noteCount - 1) : "");
                v.setTextViewText(R.id.widget_alert, alert);
                v.setInt(R.id.widget_pill, "setBackgroundResource", R.drawable.widget_status_warn);
            } else {
                v.setTextViewText(R.id.widget_alert, online ? "✓ All good" : "");
                v.setInt(R.id.widget_pill, "setBackgroundResource", R.drawable.widget_status_ok);
            }

            // Device buttons: lit while running, dimmed otherwise
            JSONObject a = o.optJSONObject("acts");
            for (int i = 0; i < DEVICE_IDS.length; i++) {
                setLit(v, DEVICE_IDS[i], a != null && a.optBoolean(DEVICE_KEYS[i]));
            }

            // Plant cycle
            JSONObject c = o.optJSONObject("cycle");
            if (c != null) {
                v.setTextViewText(R.id.widget_cycle_title, c.optString("crop") + " · " + c.optString("stage"));
                v.setTextViewText(R.id.widget_cycle_day, "Day " + c.optInt("day") + "/" + c.optInt("total"));
                v.setProgressBar(R.id.widget_cycle_bar, 100, c.optInt("pct"), false);

                String sub;
                if (c.optBoolean("finished")) {
                    sub = "Cycle complete · ready to harvest 🌾";
                } else {
                    int left = c.optInt("daysLeft");
                    String next = c.optString("next", "");
                    sub = left + (left == 1 ? " day" : " days") + " left in this stage · "
                        + (next.isEmpty() ? "then harvest" : "next: " + next);
                }
                v.setTextViewText(R.id.widget_cycle_sub, sub);
            }

            // Tank and fertilizer levels
            setLevel(v, o, "tank", R.id.res_water_val, R.id.res_water_bar);
            setLevel(v, o, "feed", R.id.res_feed_val, R.id.res_feed_bar);
            boolean hasLevels = has(o, "tank") || has(o, "feed");

            // Resizing: the taller the widget, the more it shows. Whatever height is left over is shared
            // out between the visible sections (layout weights), so nothing is left empty.
            boolean showCycle = c != null && h >= 185;
            v.setViewVisibility(R.id.widget_cycle_box, showCycle ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.widget_cycle_sub, showCycle && h >= 262 ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.widget_actions_box, h >= 245 ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.widget_res_box, hasLevels && h >= 295 ? View.VISIBLE : View.GONE);
        } catch (Exception e) {
            v.setTextViewText(R.id.widget_status, "Open the app to refresh");
        }
        return v;
    }
}
