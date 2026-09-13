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
import FirstRunWizard from './pages/FirstRunWizard';
import Login from './pages/Login';
import api, { setAccessToken, setLogoutHandler } from './services/api';

const OutOfScopeNotice: React.FC<{ name: string; description: string }> = ({ name, description }) => (
  <div className="max-w-3xl mx-auto my-16 p-8 bg-graphite-850 border border-amber-500/30 rounded-xl text-center shadow-xl">
    <div className="inline-flex p-3 rounded-full bg-amber-500/10 text-amber-400 mb-4 ring-1 ring-amber-500/20">
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
    </div>
    <h2 className="text-xl font-bold text-slate-100 mb-2">{name} — Out of Scope for Commercial V1</h2>
    <p className="text-slate-400 text-sm max-w-lg mx-auto leading-relaxed">{description}</p>
    <div className="mt-6 pt-6 border-t border-graphite-700/60 text-xs text-slate-400 font-mono">
      Commercial Scope Frozen under VigilOne Master Commercialization Execution Contract
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
  }, []);

  useEffect(() => {
    setLogoutHandler(handleLogout);

    const savedUser = localStorage.getItem('vigilone_user');
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
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
          })
          .catch(() => {
            setAccessToken(null);
            setToken(null);
            setUser(null);
          });
      })
      .catch(() => {
        // Fallback: assume bootstrapped and attempt login
        setIsBootstrapped(true);
        setAccessToken(null);
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [handleLogout]);

  const handleLoginSuccess = (userData: any, userToken: string) => {
    setAccessToken(userToken);
    setToken(userToken);
    setUser(userData);
    localStorage.setItem('vigilone_user', JSON.stringify(userData));
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
      <div className="min-h-screen bg-graphite-900 flex items-center justify-center text-slate-400 font-mono text-xs">
        Initializing VigilOne Surveillance Appliance...
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
    <div className="min-h-screen bg-graphite-900 flex flex-col font-sans text-slate-100">
      <Navbar
        currentTab={currentTab}
        onSelectTab={handleSelectTab}
        user={user}
        onLogout={handleLogout}
      />

      <main className="flex-1">
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
