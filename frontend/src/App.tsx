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
import AnprConsole from './pages/AnprConsole';
import FederationConsole from './pages/FederationConsole';
import Investigation from './pages/Investigation';
import FloorplanView from './pages/FloorplanView';
import IdentitySettings from './pages/IdentitySettings';
import Login from './pages/Login';
import api, { setAccessToken, setLogoutHandler } from './services/api';

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any | null>(null);
  const [currentTab, setCurrentTab] = useState('live');
  const [loading, setLoading] = useState(true);

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

    // Transparently refresh in-memory access token via HttpOnly cookie
    api
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
        {currentTab === 'anpr' && <AnprConsole />}
        {currentTab === 'events' && <Events />}
        {currentTab === 'evidence' && <Evidence />}
        {currentTab === 'identity' && <IdentitySettings />}
        {currentTab === 'federation' && <FederationConsole />}
        {currentTab === 'users' && <Users />}
        {currentTab === 'audit' && <AuditLogs />}
        {currentTab === 'license' && <License />}
      </main>
    </div>
  );
};

export default App;
