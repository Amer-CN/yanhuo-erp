import { useRef, useState } from 'react';
import { Download, Upload, Smartphone, Trash2 } from 'lucide-react';
import { clearAllData, setSetting } from '../../db/repo';
import { exportBackup, importMerge, parseBackup } from '../../db/merge';
import { SETTING_KEYS } from '../../db/types';
import { Btn, Card, Field, Sheet } from '../kit';

export default function SettingsPage({
  settings,
  deviceId,
  onDone
}: {
  settings: Record<string, string>;
  deviceId: string;
  onDone: (msg: string) => void;
}) {
  const [deviceName, setDeviceName] = useState(settings[SETTING_KEYS.deviceName] ?? '');
  const [opA, setOpA] = useState(settings[SETTING_KEYS.operatorA] ?? '我');
  const [opB, setOpB] = useState(settings[SETTING_KEYS.operatorB] ?? '老婆');
  const [warn, setWarn] = useState(settings[SETTING_KEYS.expiryWarnDays] ?? '30');
  const fileRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const saveText = async (key: string, value: string) => {
    await setSetting(key, value);
  };

  const doExport = async () => {
    try {
      const backup = await exportBackup(deviceId);
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
        d.getDate()
      ).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(
        2,
        '0'
      )}`;
      a.href = url;
      a.download = `烟花账-备份-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      onDone('备份已导出，记得发微信存一份');
    } catch (e) {
      onDone('导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const backup = parseBackup(text);
      const r = await importMerge(backup);
      onDone(
        `合并完成：商品 +${r.productsAdded}/改${r.productsUpdated}，进货 +${r.batchesAdded}，销售 +${r.ordersAdded} 单`
      );
    } catch (e) {
      onDone('导入失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="page-stack">
      <Card>
        <h2 className="section-title">本机与操作人</h2>
        <div className="page-stack" style={{ marginTop: 10 }}>
          <Field label="这台设备叫什么（两台设备别重名）">
            <input
              className="glass-input"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              onBlur={() => saveText(SETTING_KEYS.deviceName, deviceName.trim() || '本机')}
              placeholder="手机 / 平板"
            />
          </Field>
          <div className="form-row">
            <Field label="操作人 A">
              <input
                className="glass-input"
                value={opA}
                onChange={(e) => setOpA(e.target.value)}
                onBlur={() => saveText(SETTING_KEYS.operatorA, opA.trim() || '我')}
              />
            </Field>
            <Field label="操作人 B">
              <input
                className="glass-input"
                value={opB}
                onChange={(e) => setOpB(e.target.value)}
                onBlur={() => saveText(SETTING_KEYS.operatorB, opB.trim() || '老婆')}
              />
            </Field>
          </div>
          <Field label="临期预警提前几天">
            <input
              className="glass-input"
              inputMode="numeric"
              value={warn}
              onChange={(e) => setWarn(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => saveText(SETTING_KEYS.expiryWarnDays, warn || '30')}
            />
          </Field>
          <p className="tiny-text" style={{ margin: 0 }}>
            本机编号：{deviceId.slice(0, 8)}（合并数据时用来区分来源）
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="section-title">备份与合并</h2>
        <p className="muted-text" style={{ marginTop: 8 }}>
          两台设备各自开单，收摊后：一台点「导出」发微信，另一台点「导入合并」。同一条记录不会重复计入。
        </p>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <Btn block onClick={doExport}>
            <span className="icon-text">
              <Download size={18} aria-hidden="true" /> 导出备份（发微信）
            </span>
          </Btn>
          <Btn block variant="secondary" onClick={() => fileRef.current?.click()}>
            <span className="icon-text">
              <Upload size={18} aria-hidden="true" /> 导入并合并
            </span>
          </Btn>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = '';
          }}
        />
      </Card>

      <Card>
        <h2 className="section-title">装到手机桌面</h2>
        <p className="muted-text" style={{ marginTop: 8 }}>
          安卓 Chrome / 苹果 Safari 打开本页 → 菜单「添加到主屏幕」。装好后像 App 一样全屏，断网也能开单。
          <br />
          苹果的 Safari 长期不打开可能清缓存，所以每天收摊点一次「导出备份」。
        </p>
        <Btn block variant="tertiary" onClick={() => setHelpOpen(true)}>
          <span className="icon-text">
            <Smartphone size={18} aria-hidden="true" /> 看详细步骤
          </span>
        </Btn>
      </Card>

      <Card>
        <h2 className="section-title">危险操作</h2>
        <div style={{ marginTop: 10 }}>
          <Btn
            block
            variant="danger"
            onClick={async () => {
              if (!confirm('清空所有商品、进货、销售数据？导出备份后再操作。')) return;
              if (!confirm('再确认一次：清空后无法恢复（除了导入之前导出的备份）。')) return;
              await clearAllData();
              onDone('已清空');
            }}
          >
            <span className="icon-text">
              <Trash2 size={18} aria-hidden="true" /> 清空全部数据
            </span>
          </Btn>
        </div>
        <p className="tiny-text" style={{ marginBottom: 0 }}>
          烟花账 v0.2 · 本地存储 · 不上传任何服务器
        </p>
      </Card>

      {helpOpen ? (
        <Sheet title="添加到主屏幕" onClose={() => setHelpOpen(false)}>
          <div className="page-stack">
            <div>
              <div className="cart-line__name">安卓（Chrome / Edge）</div>
              <p className="muted-text">
                右上角 ⋮ →「添加到主屏幕」→ 确认。以后从桌面图标打开。
              </p>
            </div>
            <div>
              <div className="cart-line__name">iPhone / iPad（Safari）</div>
              <p className="muted-text">
                底部「分享」按钮 → 往下找「添加到主屏幕」→ 添加。注意要用 Safari，微信里打开的不行。
              </p>
            </div>
            <div className="glass-status">
              <Smartphone size={20} aria-hidden="true" />
              <p>装好后先在飞行模式下试开一单，确认断网也能用，再拿去摊位。</p>
            </div>
            <Btn block onClick={() => setHelpOpen(false)}>
              知道了
            </Btn>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
