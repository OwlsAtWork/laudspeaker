import { Trim } from 'class-sanitizer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTemplateDto {
  @Trim()
  @IsNotEmpty()
  @MaxLength(255)
  public name: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(2000)
  public subject: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(2000)
  public text: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  public style: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(2000)
  public slackMessage: string;

  //todo for sms

  @IsNotEmpty()
  public type: 'email' | 'slack' | 'sms';
}
