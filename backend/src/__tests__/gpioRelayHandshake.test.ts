import { GpioRelayService } from '../../src/services/hardware/gpioRelay.service';
import { RelayCommandState } from '@prisma/client';

describe('GpioRelayService (Physical DI/DO Multi-Stage Confirmation Handshake)', () => {
  let service: GpioRelayService;
  let mockPrisma: any;
  const tenantId = 'tenant_relay_01';

  beforeEach(() => {
    mockPrisma = {
      digitalIoPin: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      relayCommandLog: {
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    };
    service = new GpioRelayService(mockPrisma);
  });

  describe('Pin Direction Safeguards', () => {
    it('should reject output commands targeted at INPUT sensor pins', async () => {
      mockPrisma.digitalIoPin.findUnique.mockResolvedValue({
        id: 'pin_in_01',
        pinNumber: 1,
        tenantId,
        direction: 'INPUT',
        name: 'Door Contact Switch',
      });

      await expect(
        service.executeRelayCommand({
          pinNumber: 1,
          tenantId,
          command: 'SET_HIGH',
        })
      ).rejects.toThrow('is an INPUT sensor pin and cannot be triggered as an output');
    });

    it('should throw error when pin is not configured', async () => {
      mockPrisma.digitalIoPin.findUnique.mockResolvedValue(null);

      await expect(
        service.executeRelayCommand({
          pinNumber: 99,
          tenantId,
          command: 'SET_HIGH',
        })
      ).rejects.toThrow('Digital I/O Pin 99 not configured');
    });
  });

  describe('Multi-Stage Confirmation Lifecycle (COMMAND_SENT -> ACK -> STATE_CONFIRMED)', () => {
    it('should execute full 3-stage lifecycle and confirm hardware state', async () => {
      mockPrisma.digitalIoPin.findUnique.mockResolvedValue({
        id: 'pin_out_01',
        pinNumber: 2,
        tenantId,
        direction: 'OUTPUT',
        name: 'Siren Relay',
      });
      mockPrisma.relayCommandLog.create.mockResolvedValue({
        id: 'log_cmd_01',
        pinId: 'pin_out_01',
      });

      // Successful simulated hardware
      service.setHardwareDriver(async (pinNumber, targetState) => {
        expect(pinNumber).toBe(2);
        expect(targetState).toBe('HIGH');
        return { confirmed: true };
      });

      const res = await service.executeRelayCommand({
        pinNumber: 2,
        tenantId,
        command: 'SET_HIGH',
        issuedBy: 'user_admin',
      });

      expect(res.lifecycleState).toBe(RelayCommandState.STATE_CONFIRMED);
      expect(res.logId).toBe('log_cmd_01');

      // Stage 1: COMMAND_SENT
      expect(mockPrisma.relayCommandLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lifecycleState: RelayCommandState.COMMAND_SENT,
            command: 'SET_HIGH',
            targetState: 'HIGH',
          }),
        })
      );

      // Stage 2: COMMAND_ACK
      expect(mockPrisma.relayCommandLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'log_cmd_01' },
          data: expect.objectContaining({
            lifecycleState: RelayCommandState.COMMAND_ACK,
          }),
        })
      );

      // Stage 3: STATE_CONFIRMED & Pin update
      expect(mockPrisma.digitalIoPin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pin_out_01' },
          data: { state: 'HIGH' },
        })
      );
    });

    it('should mark command as COMMAND_FAILED when hardware fails to confirm', async () => {
      mockPrisma.digitalIoPin.findUnique.mockResolvedValue({
        id: 'pin_out_02',
        pinNumber: 3,
        tenantId,
        direction: 'OUTPUT',
        name: 'Gate Motor Relay',
      });
      mockPrisma.relayCommandLog.create.mockResolvedValue({
        id: 'log_cmd_02',
        pinId: 'pin_out_02',
      });

      // Hardware driver reports rejection
      service.setHardwareDriver(async () => {
        return { confirmed: false, error: 'Relay coil open circuit' };
      });

      const res = await service.executeRelayCommand({
        pinNumber: 3,
        tenantId,
        command: 'SET_HIGH',
      });

      expect(res.lifecycleState).toBe(RelayCommandState.COMMAND_FAILED);
      expect(res.error).toBe('Relay coil open circuit');

      expect(mockPrisma.relayCommandLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'log_cmd_02' },
          data: expect.objectContaining({
            lifecycleState: RelayCommandState.COMMAND_FAILED,
            errorMessage: 'Relay coil open circuit',
          }),
        })
      );
    });
  });
});
