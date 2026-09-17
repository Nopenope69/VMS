import React, { useState, useEffect, useCallback } from 'react';
import Navbar from './components/Navbar';
import LiveView from './pages/LiveView';
import Playback from './pages/Playback';
import Devices from './pages/Devices';
import Events from './pages/Events';
import Evidence from './pages/Evidence';
import Users from './pages/Users';
import AuditLogs from './pages/AuditLogs';
import License from './pages/License';
import Investigation from './pages/Investigation';
import FloorplanView from './pages/FloorplanView';
import StorageManagement from './pages/StorageManagement';
import ApplianceConsole from './pages/ApplianceConsole';
import { AlertTriangle } from 'lucide-react';
import FirstRunWizard from './pages/FirstRunWizard';
import Login from './pages/Login';
import api, { setAccessToken, setLogoutHandler } from './services/api';

const OutOfScopeNotice: React.FC<{ name: string; description: string }> = ({ name, description }) => (
  <div className="max-w-2xl mx-auto my-16 p-6">
    <div className="bg-vms-panel border border-vms-border rounded-lg p-6 space-y-4 shadow-lg">
      <div className="flex items-center justify-between border-b border-vms-border pb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-status-warn" />
          <span className="text-xs font-bold text-vms-text tracking-wider uppercase">
            Architectural Scope Boundary
          </span>
        </div>
        <span className="text-[11px] font-mono text-vms-muted uppercase">
          Spec: v1.0.0 Air-Gapped Appliance
        </span>
      </div>

      <div className="p-4 bg-vms-bg border border-vms-border rounded">
        <h2 className="text-sm font-semibold text-vms-text mb-1 flex items-center gap-2">
          <span>{name}</span>
        </h2>
        <p className="text-xs text-vms-muted leading-relaxed">
          {description}
        </p>
      </div>

      <div className="flex items-center justify-between pt-2 text-[11px] font-mono text-vms-dim">
        <span>VigilOne Master Architecture Execution Directive</span>
        <span className="text-status-warn">Roadmap: Commercial v2.0</span>
      </div>
    </div>
  </div>
);

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any | null>(null);
  const [currentTab, setCurrentTab] = useState('live');
  const [loading, setLoading] = useState(true);
  const [isBootstrapped, setIsBootstrapped] = useState<boolean | null>(null);

  const handleLogout = useCallback(() => {
    api.post('/auth/logout').catch(() => {});
    setAccessToken(null);
    setToken(null);
    setUser(null);
    localStorage.removeItem('vigilone_user');
    localStorage.removeItem('vigilone_token');
  }, []);

  useEffect(() => {
    setLogoutHandler(handleLogout);

    const savedUser = localStorage.getItem('vigilone_user');
    const savedToken = localStorage.getItem('vigilone_token');
    if (savedUser && savedToken) {
      try {
        const parsed = JSON.parse(savedUser);
        setUser(parsed);
        setToken(savedToken);
        setAccessToken(savedToken);
      } catch {}
    }

    // Step 1: Query appliance bootstrap state
    api
      .get('/auth/bootstrap/status')
      .then((statusRes) => {
        if (statusRes.data && statusRes.data.isBootstrapped === false) {
          setIsBootstrapped(false);
          setLoading(false);
          return;
        }

        setIsBootstrapped(true);

        // Step 2: Transparently refresh in-memory access token via HttpOnly cookie
        return api
          .post('/auth/refresh')
          .then((res) => {
            setAccessToken(res.data.token);
            setToken(res.data.token);
            setUser(res.data.user);
            localStorage.setItem('vigilone_user', JSON.stringify(res.data.user));
            localStorage.setItem('vigilone_token', res.data.token);
          })
          .catch(() => {
            if (!savedToken) {
              setAccessToken(null);
              setToken(null);
              setUser(null);
            }
          });
      })
      .catch(() => {
        // Fallback: assume bootstrapped and attempt login
        setIsBootstrapped(true);
        if (!savedToken) {
          setAccessToken(null);
          setToken(null);
          setUser(null);
        }
      })
      .finally(() => setLoading(false));
  }, [handleLogout]);

  const handleLoginSuccess = (userData: any, userToken: string) => {
    setAccessToken(userToken);
    setToken(userToken);
    setUser(userData);
    localStorage.setItem('vigilone_user', JSON.stringify(userData));
    localStorage.setItem('vigilone_token', userToken);
  };

  const allowedTabsByRole: Record<string, string[]> = {
    VIEWER: ['live', 'investigation', 'floorplans', 'playback'],
    OPERATOR: ['live', 'investigation', 'floorplans', 'playback', 'devices', 'anpr', 'events'],
    TENANT_ADMIN: [
      'live',
      'investigation',
      'floorplans',
      'playback',
      'devices',
      'anpr',
      'events',
      'evidence',
      'identity',
      'federation',
      'users',
      'audit',
      'license',
      'storage',
    ],
    SUPER_ADMIN: [
      'live',
      'investigation',
      'floorplans',
      'playback',
      'devices',
      'anpr',
      'events',
      'evidence',
      'identity',
      'federation',
      'users',
      'audit',
      'license',
      'storage',
      'appliance',
    ],
  };

  const userRole = user?.role || 'VIEWER';
  const allowedTabs = allowedTabsByRole[userRole] || allowedTabsByRole.VIEWER;

  useEffect(() => {
    if (user && !allowedTabs.includes(currentTab)) {
      setCurrentTab('live');
    }
  }, [user, currentTab, allowedTabs]);

  const handleSelectTab = (tab: string) => {
    if (allowedTabs.includes(tab)) {
      setCurrentTab(tab);
    } else {
      setCurrentTab('live');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-vms-bg flex items-center justify-center text-vms-muted font-mono text-xs">
        <div className="flex items-center space-x-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
          <span>Initializing VigilOne Surveillance Console...</span>
        </div>
      </div>
    );
  }

  // If appliance has not been provisioned, present zero-terminal first-run setup wizard
  if (isBootstrapped === false) {
    return (
      <FirstRunWizard
        onBootstrapComplete={(userData, userToken) => {
          setIsBootstrapped(true);
          handleLoginSuccess(userData, userToken);
        }}
        onSwitchToLogin={() => setIsBootstrapped(true)}
      />
    );
  }

  if (!token || !user) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-vms-bg flex flex-col font-sans text-vms-text">
      <Navbar
        currentTab={currentTab}
        onSelectTab={handleSelectTab}
        user={user}
        onLogout={handleLogout}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {currentTab === 'live' && (
          <LiveView
            onNavigateToDevices={() => handleSelectTab('devices')}
            onNavigateToAlarms={() => handleSelectTab('events')}
          />
        )}
        {currentTab === 'playback' && <Playback />}
        {currentTab === 'investigation' && <Investigation />}
        {currentTab === 'floorplans' && <FloorplanView />}
        {currentTab === 'devices' && <Devices />}
        {currentTab === 'anpr' && (
          <OutOfScopeNotice
            name="ANPR & Automated Fleet Monitoring"
            description="Automatic Number Plate Recognition (ANPR) is out of scope for the v1.0.0 edge NVR appliance (no local OCR/inference engine attached). Planned for v2.0."
          />
        )}
        {currentTab === 'events' && <Events />}
        {currentTab === 'evidence' && <Evidence />}
        {currentTab === 'identity' && (
          <OutOfScopeNotice
            name="Enterprise SSO & Identity Federation"
            description="OIDC/SAML single sign-on is out of scope for v1.0.0. Authentication strictly uses local cryptographically secured credentials."
          />
        )}
        {currentTab === 'federation' && (
          <OutOfScopeNotice
            name="Multi-Site Edge Mesh Federation"
            description="WAN mesh sync between multiple appliances is out of scope for v1.0.0. Each appliance operates as an autonomous edge NVR."
          />
        )}
        {currentTab === 'users' && <Users />}
        {currentTab === 'audit' && <AuditLogs />}
        {currentTab === 'license' && <License />}
        {currentTab === 'storage' && <StorageManagement />}
        {currentTab === 'appliance' && <ApplianceConsole />}
      </main>
    </div>
  );
};

export default App;
