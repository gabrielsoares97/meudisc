package com.meudisc.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {
    // Os arquivos do app ficam dentro do APK (assets/www) e são servidos neste endereço https:
    // microfone e câmera só funcionam em páginas seguras.
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/index.html";
    private static final String TAG = "MeuDisc";
    private static final int REQ_MEDIA = 1;
    private static final int REQ_NOTIFY = 2;
    private static final int MATCH = ViewGroup.LayoutParams.MATCH_PARENT;

    private FrameLayout root;
    private WebView web;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    // Pedidos de microfone/câmera da página: um de cada vez para o Android.
    private PermissionRequest pendingRequest;
    private final List<PermissionRequest> waiting = new ArrayList<>();
    private boolean asking;
    private boolean askedNotifications;

    private boolean inRoom;
    private String roomCode = "";
    private final Handler handler = new Handler(Looper.getMainLooper());
    // Com o app em segundo plano, os timers da página quase param. Isto mantém o "estou aqui"
    // indo para a sala a cada 2 s.
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!inRoom || web == null) return;
            web.evaluateJavascript("window.__meudiscTick && window.__meudiscTick()", null);
            handler.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF1B2029);
        web = new WebView(this);
        web.setBackgroundColor(0xFF1B2029);
        root.addView(web, new FrameLayout.LayoutParams(MATCH, MATCH));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " MeuDiscAndroid");
        // A página continua com prioridade alta mesmo com o app em segundo plano (chamada).
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.addJavascriptInterface(new Bridge(), "MeuDiscAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.loadUrl(START_URL);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(tick);
        stopService(new Intent(this, CallService.class));
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ arquivos do app
    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
            if (path.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open("www" + path);
                String mime = mimeOf(path);
                boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
                WebResourceResponse r = new WebResourceResponse(mime, text ? "utf-8" : null, in);
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-cache");
                r.setResponseHeaders(h);
                return r;
            } catch (IOException e) {
                return notFound();
            }
        }

        // Links de fora abrem no navegador do celular, nunca dentro do app.
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception e) {
                Log.w(TAG, "link", e);
            }
            return true;
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------ permissões, tela cheia
    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> handlePermission(request));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            waiting.remove(request);
            if (pendingRequest == request) pendingRequest = null;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            showFullscreen(view, callback);
        }

        @Override
        public void onHideCustomView() {
            hideFullscreen();
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    private static String permissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        return null;
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void handlePermission(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (origin == null || !HOST.equals(origin.getHost())) {
            request.deny();
            return;
        }
        if (asking) {
            waiting.add(request);
            return;
        }
        List<String> missing = new ArrayList<>();
        for (String r : request.getResources()) {
            String p = permissionFor(r);
            if (p != null && !granted(p) && !missing.contains(p)) missing.add(p);
        }
        if (missing.isEmpty()) {
            grantAllowed(request);
            return;
        }
        // Na primeira vez, pede junto a permissão da notificação "você está na sala".
        if (Build.VERSION.SDK_INT >= 33 && inRoom && !askedNotifications
                && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            askedNotifications = true;
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        pendingRequest = request;
        asking = true;
        requestPermissions(missing.toArray(new String[0]), REQ_MEDIA);
    }

    private void grantAllowed(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            String p = permissionFor(r);
            if (p != null && granted(p)) ok.add(r);
        }
        if (ok.isEmpty()) request.deny();
        else request.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        asking = false;
        if (code == REQ_MEDIA && pendingRequest != null) {
            PermissionRequest r = pendingRequest;
            pendingRequest = null;
            grantAllowed(r);
        }
        // Microfone liberado com a sala aberta: a notificação passa a manter o microfone ligado
        // em segundo plano.
        if (inRoom) startCallService();
        while (!asking && !waiting.isEmpty()) handlePermission(waiting.remove(0));
    }

    private void showFullscreen(View view, WebChromeClient.CustomViewCallback callback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden();
            return;
        }
        fullscreenView = view;
        fullscreenCallback = callback;
        view.setBackgroundColor(0xFF000000);
        root.addView(view, new FrameLayout.LayoutParams(MATCH, MATCH));
        web.setVisibility(View.INVISIBLE);
        setSystemBarsHidden(true);
        // Transmissões são de tela de PC: em tela cheia, deita o celular.
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    }

    private void hideFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        fullscreenCallback = null;
        if (web != null) web.setVisibility(View.VISIBLE);
        setSystemBarsHidden(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean hide) {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = hide
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            w.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c == null) return;
            if (hide) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.systemBars());
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            w.getDecorView().setSystemUiVisibility(hide
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    : 0);
        }
    }

    // Voltar: sai da tela cheia, fecha o que estiver aberto na página; com nada aberto, o app vai
    // para segundo plano (se estiver numa sala, a chamada continua).
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
            hideFullscreen();
            return;
        }
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.__meudiscBack ? window.__meudiscBack() : false", value -> {
            if ("true".equals(value)) return;
            if (inRoom) moveTaskToBack(true);
            else finish();
        });
    }

    // ------------------------------------------------------------ sala aberta
    private void applyInRoom(boolean on, String code) {
        inRoom = on;
        roomCode = code == null ? "" : code;
        handler.removeCallbacks(tick);
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            handler.postDelayed(tick, 2000);
            startCallService();
            // Microfone já liberado antes: pede só a notificação (se ainda não pediu).
            if (Build.VERSION.SDK_INT >= 33 && !asking && !askedNotifications
                    && granted(Manifest.permission.RECORD_AUDIO)
                    && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
                askedNotifications = true;
                asking = true;
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFY);
            }
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            stopService(new Intent(this, CallService.class));
        }
    }

    private void startCallService() {
        try {
            startForegroundService(new Intent(this, CallService.class).putExtra("code", roomCode));
        } catch (Exception e) {
            Log.w(TAG, "notificação da sala", e);
        }
    }

    private void copy(String text) {
        ClipboardManager cm = getSystemService(ClipboardManager.class);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("MeuDisc", text));
    }

    // ------------------------------------------------------------ ponte com a página
    private class Bridge {
        @JavascriptInterface
        public void setInRoom(final boolean on, final String code) {
            runOnUiThread(() -> applyInRoom(on, code));
        }

        @JavascriptInterface
        public void shareText(final String text) {
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND)
                        .setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, text);
                try {
                    startActivity(Intent.createChooser(send, "Convidar para a sala"));
                } catch (Exception e) {
                    copy(text);
                }
            });
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(() -> copy(text));
        }
    }
}
