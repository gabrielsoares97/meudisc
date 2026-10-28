package com.meudisc.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

// Notificação "você está numa sala": enquanto ela existe, o Android deixa o microfone e o som
// da chamada funcionando com o app em segundo plano ou com a tela desligada.
public class CallService extends Service {
    private static final String CHANNEL = "sala";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Sala em andamento", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Aparece enquanto você está numa sala, para a chamada continuar com o app em segundo plano.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        String code = intent != null ? intent.getStringExtra("code") : null;
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFFF5A524)
                .setContentTitle(code != null && !code.isEmpty() ? "Na sala " + code : "Na sala do MeuDisc")
                .setContentText("A chamada continua com o app em segundo plano. Toque para voltar.")
                .setContentIntent(pi)
                .setOngoing(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_CALL)
                .build();

        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
                boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                try {
                    startForeground(1, n, mic ? type | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : type);
                } catch (RuntimeException e) {
                    startForeground(1, n, type);
                }
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(1, n);
            }
        } catch (RuntimeException e) {
            // O sistema não deixou: a sala segue funcionando com o app aberto, só sem a notificação.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    // Fechou o app pela lista de apps recentes: sai da sala.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
