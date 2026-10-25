package com.terrasense.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * "Plant buddy" widget: a pixel-art companion that grows with your plant and reacts to the greenhouse
 * (happy, hot, cold, sleeping, drinking, celebrating, thirsty). Resizable. Reads the snapshot the app saves.
 *
 * Sprite sheets (res/drawable-nodpi/pet_<plant>.png): 8 frames across, rows = stage * 7 + mood, 32 px cells.
 */
public class PetWidget extends AppWidgetProvider {
    private static final String PREFS = "terrasense_widget";
    private static final String ACTION_PREV = "com.terrasense.app.PET_PREV";
    private static final String ACTION_NEXT = "com.terrasense.app.PET_NEXT";
    private static final int CELL = 32;
    private static final String[] MOODS = {"happy", "hot", "cold", "sleep", "drink", "celebrate", "thirsty"};
    private static final int[] FRAMES = {8, 4, 4, 4, 8, 8, 4};
    /** Which of the 5 flippers (100, 160, 200, 330, 500 ms per frame) plays each mood. */
    private static final int[] FLIPPER = {2, 2, 0, 4, 1, 0, 3};

    private static final Map<String, Bitmap> SHEETS = new HashMap<>();

    static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PetWidget.class));
        for (int id : ids) mgr.updateAppWidget(id, build(ctx, mgr.getAppWidgetOptions(id)));
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(ctx, mgr.getAppWidgetOptions(id)));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String a = intent.getAction();
        if (ACTION_PREV.equals(a) || ACTION_NEXT.equals(a)) {
            shift(ctx, ACTION_NEXT.equals(a) ? 1 : -1);
            refreshAll(ctx);
            TerraSenseWidget.refreshAll(ctx);   // the main widget follows the pet's choice
        }
    }

    private static JSONArray readList(SharedPreferences p) {
        try { return new JSONArray(p.getString("list", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private static boolean inList(JSONArray list, String id) {
        for (int i = 0; i < list.length(); i++) {
            JSONObject it = list.optJSONObject(i);
            if (it != null && it.optString("id").equals(id)) return true;
        }
        return false;
    }

    /** Same greenhouse as the main widget: both read and change the one shared "selected" value. */
    private static String petSelected(SharedPreferences p, JSONArray list) {
        return p.getString("selected", "");
    }

    private static void shift(Context ctx, int dir) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray list = readList(p);
            if (list.length() < 2) return;
            String cur = petSelected(p, list);
            int idx = 0;
            for (int i = 0; i < list.length(); i++) if (list.getJSONObject(i).optString("id").equals(cur)) idx = i;
            idx = (idx + dir + list.length()) % list.length();
            p.edit().putString("selected", list.getJSONObject(idx).optString("id")).apply();
        } catch (Exception ignored) { }
    }

    private static PendingIntent broadcast(Context ctx, String action, int code) {
        Intent i = new Intent(ctx, PetWidget.class).setAction(action);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        mgr.updateAppWidget(id, build(ctx, options));       // resized: redraw at the new size
    }

    private static Bitmap sheet(Context ctx, String plant) {
        Bitmap b = SHEETS.get(plant);
        if (b != null) return b;
        int res = ctx.getResources().getIdentifier("pet_" + plant, "drawable", ctx.getPackageName());
        if (res == 0) res = ctx.getResources().getIdentifier("pet_tomato", "drawable", ctx.getPackageName());
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inScaled = false;
        b = BitmapFactory.decodeResource(ctx.getResources(), res, o);
        SHEETS.put(plant, b);
        return b;
    }

    private static int idOf(Context ctx, String name) {
        return ctx.getResources().getIdentifier(name, "id", ctx.getPackageName());
    }

    private static String num(JSONObject o, String key, String unit, boolean whole, String icon) {
        if (o == null || o.isNull(key) || !o.has(key)) return icon + " —";
        double v = o.optDouble(key);
        if (Double.isNaN(v)) return icon + " —";
        return icon + " " + (whole ? String.valueOf(Math.round(v)) : String.format(Locale.US, "%.1f", v)) + unit;
    }

    static RemoteViews build(Context ctx, Bundle options) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.pet_widget);

        int w = options != null ? options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180) : 180;
        int h = options != null ? options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180) : 180;

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) {
            v.setOnClickPendingIntent(R.id.pet_root,
                PendingIntent.getActivity(ctx, 100, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }

        // ---- what to show
        String plant = "tomato", mood = "happy", msg = "Open TerraSense to meet your plant", label = "TerraSense";
        int stage = 0;
        JSONObject snap = null;
        JSONArray list = new JSONArray();
        try {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            list = readList(p);
            String sel = petSelected(p, list);
            String raw = sel.isEmpty() ? null : p.getString("gh_" + sel, null);
            if (raw == null && list.length() > 0 && !sel.isEmpty()) {
                // A greenhouse the app hasn't sent data for yet (for example it is offline): show it as a
                // sleeping page so the arrows still work.
                String name = "Greenhouse";
                for (int i = 0; i < list.length(); i++) {
                    JSONObject it = list.optJSONObject(i);
                    if (it != null && it.optString("id").equals(sel)) name = it.optString("name", name);
                }
                mood = "sleep";
                label = name;
                msg = "No data yet for " + name;
            }
            if (raw != null) {
                snap = new JSONObject(raw);
                JSONObject pet = snap.optJSONObject("pet");
                if (pet != null) {
                    plant = pet.optString("plant", plant);
                    mood = pet.optString("mood", mood);
                    msg = pet.optString("msg", "");
                    label = pet.optString("label", snap.optString("name", "Greenhouse"));
                    stage = Math.max(0, Math.min(3, pet.optInt("stage", 0)));
                }
            }
        } catch (Exception ignored) { }

        // ---- ‹ › : switch greenhouse (shown whenever there are 2 or more)
        boolean many = list.length() > 1;
        v.setViewVisibility(R.id.pet_prev, many ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.pet_next, many ? View.VISIBLE : View.GONE);
        v.setOnClickPendingIntent(R.id.pet_prev, broadcast(ctx, ACTION_PREV, 101));
        v.setOnClickPendingIntent(R.id.pet_next, broadcast(ctx, ACTION_NEXT, 102));

        int moodIdx = 0;
        for (int i = 0; i < MOODS.length; i++) if (MOODS[i].equals(mood)) moodIdx = i;

        // ---- layout by size (3 x 3 cells is about 180 x 180 dp)
        boolean showTitle = h >= 120;
        boolean showMsg = h >= 100;
        boolean showStats = h >= 185 && snap != null;
        v.setViewVisibility(R.id.pet_title, showTitle ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.pet_msg, showMsg ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.pet_stats, showStats ? View.VISIBLE : View.GONE);
        v.setTextViewText(R.id.pet_title, label);
        v.setTextViewText(R.id.pet_msg, msg);
        if (showStats) {
            v.setTextViewText(R.id.pet_temp, num(snap, "temp", "°", false, "🌡"));
            v.setTextViewText(R.id.pet_hum, num(snap, "hum", "%", true, "💧"));
            v.setTextViewText(R.id.pet_soil, num(snap, "soil", "%", true, "🌱"));
        }

        // ---- sprite size: biggest whole multiple of 32 px that fits (capped to keep the widget light)
        float density = ctx.getResources().getDisplayMetrics().density;
        float availDp = Math.min(w - 20, h - 20 - (showTitle ? 20 : 0) - (showMsg ? 46 : 0) - (showStats ? 28 : 0));
        int k = Math.round(availDp * density / CELL);
        k = Math.max(2, Math.min(4, k));
        int size = CELL * k;

        // ---- frames
        Bitmap sh = sheet(ctx, plant);
        int row = stage * MOODS.length + moodIdx;
        int n = FRAMES[moodIdx];
        Bitmap[] frames = new Bitmap[n];
        for (int f = 0; f < n; f++) {
            Bitmap cell = Bitmap.createBitmap(sh, f * CELL, row * CELL, CELL, CELL);
            frames[f] = Bitmap.createScaledBitmap(cell, size, size, false);     // crisp pixels
        }

        // ---- play them: only the flipper with the right speed is shown and filled
        int active = FLIPPER[moodIdx];
        for (int fi = 0; fi < 5; fi++) {
            v.setViewVisibility(idOf(ctx, "pf" + fi), fi == active ? View.VISIBLE : View.GONE);
        }
        for (int i = 0; i < 8; i++) {
            v.setImageViewBitmap(idOf(ctx, "pf" + active + "_" + i), frames[i % n]);   // 4-frame loops repeat twice
        }
        return v;
    }
}
