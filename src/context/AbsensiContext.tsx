import * as React from 'react';
import { Absensi } from '../types';
import { INITIAL_ABSENSI } from '../data/initialData';
import { useAuth } from './AuthContext';
import { useSettings } from './SettingsContext';
import { useToast } from '../hooks/useToast';
import { ApiService } from '../services/apiService';
import { InisiasiService } from '../services/inisiasiService';
import { syncManager } from '../services/syncManager';
import { getLocalDateTimeString, getWIBDateString, normalizeDateISO } from '../utils/dateUtils';

interface AbsensiContextType {
  absensiList: Absensi[];
  setAbsensiList: React.Dispatch<React.SetStateAction<Absensi[]>>;
  addAbsensi: (abs: Omit<Absensi, 'id' | 'createdAt'>) => Promise<Absensi>;
  updateAbsensi: (id: string, absData: Partial<Absensi>) => Promise<boolean>;
  deleteAbsensi: (id: string) => Promise<boolean>;
  refreshAbsensi: () => Promise<void>;
  hasCheckedInToday: boolean;
  isLoading: boolean;
}

const AbsensiContext = React.createContext<AbsensiContextType | undefined>(undefined);

export function AbsensiProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { settings } = useSettings();
  const { showToast } = useToast();
  
  const activeUnitId = user?.unitId || InisiasiService.getSelectedUnitId() || 'UL2';

  const [absensiList, setAbsensiList] = React.useState<Absensi[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);

  const refreshAbsensi = React.useCallback(async () => {
  try {
    const unitId = activeUnitId;

    if (!unitId) {
      console.warn('[ABSENSI] UnitId tidak tersedia.');
      return;
    }

    console.log('[ABSENSI TRACE] refreshAbsensi triggered. UnitId:', unitId);

    const res = await ApiService.fetchAbsensi(unitId);

    if (res.success && res.data) {
      const filtered = res.data.filter(
        a => !a.unitId || InisiasiService.isUserMatchingUnit(a.unitId, unitId)
      );

      console.log(
        '[ABSENSI TRACE] fetchAbsensi success. Received:',
        res.data.length,
        'Filtered:',
        filtered.length
      );

      setAbsensiList(filtered);
    } else {
      console.warn('[ABSENSI] HyperCloud tidak mengembalikan data:', res);
    }
  } catch (err) {
    console.error('[ABSENSI] Error loading from HyperCloud API:', err);
  }
}, [activeUnitId]);

  // Initial load and unit change refresh
  React.useEffect(() => {
    refreshAbsensi();
  }, [refreshAbsensi, activeUnitId]);

  const addAbsensi = React.useCallback(async (absData: Omit<Absensi, 'id' | 'createdAt'>) => {
    console.log(`[ABSENSI TRACE 4] addAbsensi called. Regu: ${absData.reguName}`);
    const todayStr = absData.tanggal || getWIBDateString();
    const nowStr = getLocalDateTimeString();

    const normalizeDate = (d: any) => {
      if (!d) return '';
      const s = String(d).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (match) {
        return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
      return s.slice(0, 10);
    };

    const targetDate = normalizeDate(todayStr);

    const existingIndex = absensiList.findIndex(a => {
      if (!a) return false;
      const rowDate = normalizeDate(a.tanggal);
      const rowRegu = (a.reguName || '').trim().toLowerCase();
      const targetRegu = (absData.reguName || '').trim().toLowerCase();
      return rowDate === targetDate && rowRegu === targetRegu;
    });

    let finalAbs: Absensi;

    if (existingIndex >= 0) {
      const existing = absensiList[existingIndex];
      const isClockingOut = Boolean(absData.fotoKeluar);
      
      if (isClockingOut) {
        finalAbs = {
          ...existing,
          fotoKeluar: absData.fotoKeluar,
          timestampKeluar: absData.timestampKeluar || nowStr,
          latitude: absData.latitude || existing.latitude,
          longitude: absData.longitude || existing.longitude,
          updatedAt: getLocalDateTimeString(),
        };
      } else {
        finalAbs = {
          ...existing,
          ...absData,
          fotoMasuk: absData.fotoMasuk || existing.fotoMasuk,
          timestampMasuk: existing.timestampMasuk || (absData.fotoMasuk ? nowStr : undefined),
          fotoKeluar: absData.fotoKeluar || existing.fotoKeluar,
          timestampKeluar: absData.fotoKeluar ? (absData.timestampKeluar || nowStr) : existing.timestampKeluar,
          updatedAt: getLocalDateTimeString(),
        };
      }
    } else {
      finalAbs = {
        ...absData,
        id: 'ABS-' + Date.now(),
        timestampMasuk: absData.fotoMasuk ? nowStr : undefined,
        timestampKeluar: absData.fotoKeluar ? nowStr : undefined,
        createdAt: getLocalDateTimeString(),
      };
    }

    // 1. ONLINE-FIRST: Try to save directly to HyperCloud API
    const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
    
    if (isOnline) {
      console.log(`[ABSENSI TRACE 4] Online Mode. Sending to ApiService...`);
      try {
        const result = existingIndex >= 0 
          ? await ApiService.updateAbsensi(finalAbs.id, finalAbs)
          : await ApiService.saveAbsensi(finalAbs);

        if (result.success) {
          console.log(`[ABSENSI TRACE 4] API SUCCESS. ID: ${finalAbs.id}. Result:`, result);
          showToast('Absensi berhasil tersimpan ke Database HyperCloud!', 'success');
          // Update local state IMMEDIATELY
          const newList = [...absensiList];
          if (existingIndex >= 0) {
            newList[existingIndex] = finalAbs;
          } else {
            newList.unshift(finalAbs);
          }
          setAbsensiList(newList);
          
          console.log(`[ABSENSI TRACE 4] Triggering refreshAbsensi() to sync server state...`);
          await refreshAbsensi();
          return finalAbs;
        } else {
          console.error(`[ABSENSI TRACE 4] API FAILED: ${result.message}`);
          showToast(`Gagal menyimpan ke server: ${result.message}`, 'error');
        }
      } catch (err: any) {
        console.error('[ABSENSI TRACE 4] addAbsensi Exception:', err);
      }
    }

    // 2. OFFLINE FALLBACK: Use syncManager to queue the operation
    try {
      await syncManager.executeMutation({
        type: existingIndex >= 0 ? 'UPDATE' : 'CREATE',
        tableName: 'ABSENSI',
        payload: finalAbs,
        apiCall: async () => {
          const result = existingIndex >= 0 
            ? await ApiService.updateAbsensi(finalAbs.id, finalAbs)
            : await ApiService.saveAbsensi(finalAbs);
          return { status: result.success ? 'success' : 'error', message: result.message };
        }
      });

      // Optimistic update for offline
      const newList = [...absensiList];
      if (existingIndex >= 0) {
        newList[existingIndex] = finalAbs;
      } else {
        newList.unshift(finalAbs);
      }
      setAbsensiList(newList);
      showToast('Koneksi terganggu. Absensi disimpan di antrean offline.', 'info');
    } catch (err) {
      console.warn('Sync Absensi error:', err);
      showToast('Gagal sinkronisasi, tersimpan lokal.', 'info');
    }

    return finalAbs;
  }, [absensiList, setAbsensiList, showToast, refreshAbsensi]);

  const updateAbsensi = React.useCallback(async (id: string, absData: Partial<Absensi>) => {
    const existingIndex = absensiList.findIndex(a => a.id === id);
    if (existingIndex === -1) return false;

    const updatedAbs = {
      ...absensiList[existingIndex],
      ...absData,
      updatedAt: getLocalDateTimeString(),
    };

    const isOnline = typeof navigator !== 'undefined' && navigator.onLine;

    if (isOnline) {
      try {
        const result = await ApiService.updateAbsensi(id, updatedAbs);
        if (result.success) {
          showToast('Perubahan absensi tersimpan ke Database', 'success');
          const newList = [...absensiList];
          newList[existingIndex] = updatedAbs;
          setAbsensiList(newList);
          await refreshAbsensi();
          return true;
        }
      } catch {}
    }

    try {
      await syncManager.executeMutation({
        type: 'UPDATE',
        tableName: 'ABSENSI',
        payload: updatedAbs,
        apiCall: async () => {
          const result = await ApiService.updateAbsensi(id, updatedAbs);
          return { status: result.success ? 'success' : 'error', message: result.message };
        }
      });
      
      const newList = [...absensiList];
      newList[existingIndex] = updatedAbs;
      setAbsensiList(newList);
      showToast('Perubahan tersimpan (offline).', 'info');
      return true;
    } catch {
      showToast('Perubahan gagal disimpan.', 'error');
      return false;
    }
  }, [absensiList, setAbsensiList, showToast, refreshAbsensi]);

  const deleteAbsensi = React.useCallback(async (id: string) => {
    console.log(`[ABSENSI TRACE 5] deleteAbsensi called. ID: ${id}`);
    const isOnline = typeof navigator !== 'undefined' && navigator.onLine;

    if (isOnline) {
      console.log(`[ABSENSI TRACE 5] Online Mode. Sending DELETE to API...`);
      try {
        const result = await ApiService.deleteAbsensi(id);
        if (result.success) {
          console.log(`[ABSENSI TRACE 5] DELETE SUCCESS. ID: ${id}`);
          showToast('Absensi berhasil dihapus dari Database', 'success');
          // Update state
          setAbsensiList(prev => prev.filter(a => a.id !== id));
          console.log(`[ABSENSI TRACE 5] Triggering refreshAbsensi() to sync...`);
          await refreshAbsensi();
          return true;
        } else {
          console.error(`[ABSENSI TRACE 5] DELETE FAILED: ${result.message}`);
          showToast(`Gagal menghapus: ${result.message}`, 'error');
        }
      } catch (err: any) {
        console.error('[ABSENSI TRACE 5] deleteAbsensi Exception:', err);
      }
    }

    // Offline fallback
    try {
      await syncManager.executeMutation({
        type: 'DELETE',
        tableName: 'ABSENSI',
        payload: { id },
        apiCall: async () => {
          const result = await ApiService.deleteAbsensi(id);
          return { status: result.success ? 'success' : 'error', message: result.message };
        }
      });
      setAbsensiList(prev => prev.filter(a => a.id !== id));
      showToast('Penghapusan disimpan di antrean offline.', 'info');
      return true;
    } catch (e) {
      console.warn('Delete Absensi offline error:', e);
      showToast('Gagal menghapus absensi.', 'error');
      return false;
    }
  }, [setAbsensiList, showToast, refreshAbsensi]);

  const hasCheckedInToday = React.useMemo(() => {
    if (!user || (user.role || '').toUpperCase() !== 'USER') return true;
    
    const todayISO = getWIBDateString();
    const now = new Date();
    const currentY = now.getFullYear();
    const currentM = now.getMonth();
    const currentD = now.getDate();
    
    const padStr = (num: number) => String(num).padStart(2, '0');
    const isoPrefix = `${currentY}-${padStr(currentM + 1)}-${padStr(currentD)}`;
    
    const cleanStr = (s?: string | null) => {
      if (!s) return '';
      return String(s)
        .toLowerCase()
        .trim()
        .replace(/^(regu|tim|petugas)\s+/gi, '')
        .replace(/[^a-z0-9]/gi, '');
    };

    const extractRowNo = (s?: string | null): number | null => {
      if (!s) return null;
      const match = String(s).match(/row\s*0?(\d+)/i) || String(s).match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    };

    const userReguClean = cleanStr(user.reguName);
    const userRowNo = extractRowNo(user.reguName) ?? extractRowNo(user.userName);
    const userCandidates = [
      userReguClean,
      cleanStr(user.userName),
      cleanStr(user.name),
      cleanStr(user.nip),
      cleanStr(user.id),
    ].filter(Boolean);

    return absensiList.some((abs: any) => {
      const absTanggal = String(abs.tanggal || abs.TANGGAL || abs.Tanggal || '');
      if (!absTanggal) return false;

      const normDate = normalizeDateISO(absTanggal);
      const isToday = (
        normDate === todayISO ||
        absTanggal.startsWith(isoPrefix) ||
        absTanggal.includes(`${currentY}-${padStr(currentM + 1)}-${padStr(currentD)}`) ||
        absTanggal.includes(`${currentD}/${currentM + 1}/${currentY}`) ||
        absTanggal.includes(`${padStr(currentD)}/${padStr(currentM + 1)}/${currentY}`) ||
        absTanggal.includes(`${currentD}-${currentM + 1}-${currentY}`) ||
        absTanggal.includes(`${padStr(currentD)}-${padStr(currentM + 1)}-${currentY}`) ||
        (absTanggal.length >= 10 && !isNaN(Date.parse(absTanggal)) && new Date(absTanggal).toDateString() === now.toDateString())
      );

      if (!isToday) return false;

      const absReguClean = cleanStr(abs.reguName || abs.NAMA_REGU || abs.Nama_Regu || abs.Regu);
      const absRowNo = extractRowNo(abs.reguName || abs.NAMA_REGU || abs.Nama_Regu || abs.Regu);

      if (userRowNo !== null && absRowNo !== null && userRowNo === absRowNo) {
        return true;
      }

      if (userReguClean && absReguClean) {
        if (
          userReguClean === absReguClean ||
          (userReguClean.length >= 2 && absReguClean.length >= 2 && (userReguClean.includes(absReguClean) || absReguClean.includes(userReguClean)))
        ) {
          return true;
        }
      }

      const absCandidates = [
        absReguClean,
        cleanStr(abs.userName || abs.USER_NAME || abs.Username),
        cleanStr(abs.namaPetugas || abs.NAMA_PETUGAS || abs.Nama_Petugas || abs.Petugas),
        cleanStr(abs.nip || abs.NIP),
        cleanStr(abs.userId || abs.USER_ID || abs.id),
      ].filter(Boolean);

      if (Array.isArray(abs.petugasList)) {
        for (const p of abs.petugasList) {
          if (p && p.nama) absCandidates.push(cleanStr(p.nama));
        }
      }

      for (let i = 1; i <= 5; i++) {
        const pVal = abs[`PETUGAS_${i}`] || abs[`Petugas_${i}`] || abs[`petugas_${i}`];
        if (pVal) absCandidates.push(cleanStr(pVal));
      }

      for (const uCand of userCandidates) {
        for (const aCand of absCandidates) {
          if (
            uCand === aCand ||
            (uCand.length >= 3 && aCand.length >= 3 && (uCand.includes(aCand) || aCand.includes(uCand)))
          ) {
            return true;
          }
        }
      }

      return false;
    });
  }, [absensiList, user]);

  return (
    <AbsensiContext.Provider value={{ absensiList, setAbsensiList, addAbsensi, updateAbsensi, deleteAbsensi, refreshAbsensi, hasCheckedInToday, isLoading }}>
      {children}
    </AbsensiContext.Provider>
  );
}

export function useAbsensi() {
  const context = React.useContext(AbsensiContext);
  if (context === undefined) {
    throw new Error('useAbsensi must be used within a AbsensiProvider');
  }
  return context;
}
